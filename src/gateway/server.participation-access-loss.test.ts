import type { ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";

type Fixture = Parameters<Parameters<typeof withInvitedGuestGateway>[1]>[0];
type ChatEvent = { runId?: string; state?: string; stopReason?: string };

const HELD = /hold-[a-z-]+/;

/** Streams partial text for each `hold-<id>` prompt and keeps the reply open until released. */
function holdReplies(fixture: Fixture) {
  const open = new Map<string, () => void>();
  fixture.providerReplies.reply = (body, response: ServerResponse) => {
    const id = body.includes("Generate a concise session title") ? undefined : HELD.exec(body)?.[0];
    if (!id) {
      writeOpenAiResponsesText(response, { text: "Done.", messageId: "m", responseId: "r" });
      return;
    }
    const item = { type: "message", id: `msg-${id}`, role: "assistant" };
    response.writeHead(200, { "content-type": "text/event-stream", connection: "keep-alive" });
    for (const event of [
      { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: `partial ${id}`,
      },
    ]) {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    open.set(id, () => {
      const message = {
        ...item,
        status: "completed",
        content: [{ type: "output_text", text: `partial ${id}`, annotations: [] }],
      };
      for (const event of [
        { type: "response.output_item.done", output_index: 0, item: message },
        {
          type: "response.completed",
          response: {
            id: `response-${id}`,
            status: "completed",
            output: [message],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        },
      ]) {
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      response.end("data: [DONE]\n\n");
      open.delete(id);
    });
  };
  return {
    release(id: string) {
      open.get(id)?.();
    },
    held: (id: string) => open.has(id),
  };
}

function chatEvents(fixture: Fixture, runId: string): ChatEvent[] {
  return fixture.events.sender.flatMap((event) =>
    event.event === "chat" && (event.payload as ChatEvent)?.runId === runId
      ? [event.payload as ChatEvent]
      : [],
  );
}

// The Gateway reports these transitions as events; wait for the event, not a fixed delay.
const until = (predicate: () => boolean, what: string) =>
  vi.waitFor(() => expect(predicate(), what).toBe(true), { timeout: 10_000 });

async function sharedSession(fixture: Fixture, signal: AbortSignal, label: string) {
  const session = await fixture.sender.request<{ key: string }>(
    "sessions.create",
    { agentId: "main", label, visibility: "shared" },
    { signal },
  );
  await fixture.sender.request(
    "session.members.add",
    { agentId: "main", sessionKey: session.key, identityId: fixture.carol.id, access: "send" },
    { signal },
  );
  return session.key;
}

async function startHeld(
  fixture: Fixture,
  signal: AbortSignal,
  who: "sender" | "invited",
  sessionKey: string,
  id: string,
) {
  await fixture[who].request(
    "chat.send",
    { agentId: "main", sessionKey, message: `Reply to ${id}`, idempotencyKey: id },
    { signal },
  );
}

const aborted = (fixture: Fixture, runId: string) =>
  chatEvents(fixture, runId).find((event) => event.state === "aborted");

it("stops only the removed person's runs in that session, keeps partial output and tells the session", async ({
  signal,
}) => {
  await withInvitedGuestGateway(
    signal,
    async (fixture) => {
      const replies = holdReplies(fixture);
      const removedFrom = await sharedSession(fixture, signal, "Removed from");
      const stillMember = await sharedSession(fixture, signal, "Still member");
      const ownerOnly = await sharedSession(fixture, signal, "Owner run");
      await startHeld(fixture, signal, "invited", removedFrom, "hold-carol-removed");
      await startHeld(fixture, signal, "invited", stillMember, "hold-carol-kept");
      await startHeld(fixture, signal, "sender", ownerOnly, "hold-owner");
      await until(
        () => ["hold-carol-removed", "hold-carol-kept", "hold-owner"].every(replies.held),
        "three streaming runs",
      );

      await fixture.sender.request(
        "session.members.remove",
        { agentId: "main", sessionKey: removedFrom, identityId: fixture.carol.id },
        { signal },
      );

      expect(aborted(fixture, "hold-carol-removed")).toMatchObject({
        stopReason: "access-removed",
        message: { content: [{ type: "text", text: "partial hold-carol-removed" }] },
      });
      const history = await fixture.sender.request<{ messages: unknown[] }>(
        "chat.history",
        { agentId: "main", sessionKey: removedFrom, limit: 50 },
        { signal },
      );
      const transcript = JSON.stringify(history.messages);
      expect(transcript).toContain("partial hold-carol-removed");
      expect(transcript).toContain(
        "Stopped 1 run started by Carol: their access to this session changed.",
      );

      expect(aborted(fixture, "hold-carol-kept")).toBeUndefined();
      expect(aborted(fixture, "hold-owner")).toBeUndefined();
      replies.release("hold-carol-kept");
      replies.release("hold-owner");
      for (const runId of ["hold-carol-kept", "hold-owner"]) {
        await expect(
          fixture.sender.request("agent.wait", { runId }, { signal }),
        ).resolves.toMatchObject({ status: "ok" });
      }

      const requests = fixture.providerRequests.length;
      await expect(
        fixture.invited.request(
          "chat.send",
          {
            agentId: "main",
            sessionKey: removedFrom,
            message: "after removal",
            idempotencyKey: "after-removal",
          },
          { signal },
        ),
      ).rejects.toThrow();
      expect(fixture.providerRequests).toHaveLength(requests);
    },
    { maxInvitedAccess: "send" },
  );
});

it("never runs a message accepted just before a downgrade with the old access", async ({
  signal,
}) => {
  await withInvitedGuestGateway(
    signal,
    async (fixture) => {
      holdReplies(fixture);
      const sessionKey = await sharedSession(fixture, signal, "Race");
      // Accepted, not yet executing: its start is admitted again and refused. A turn already
      // executing is stopped instead (first test).
      await startHeld(fixture, signal, "invited", sessionKey, "hold-race");
      await fixture.sender.request(
        "session.members.setAccess",
        { agentId: "main", sessionKey, identityId: fixture.carol.id, access: "read" },
        { signal },
      );
      await until(
        () =>
          chatEvents(fixture, "hold-race").some((event) =>
            ["aborted", "error", "final"].includes(event.state ?? ""),
          ),
        "race outcome",
      );
      const states = chatEvents(fixture, "hold-race").map((event) => event.state);
      expect(states).not.toContain("final");
      await expect(
        fixture.invited.request(
          "chat.send",
          { agentId: "main", sessionKey, message: "as reader", idempotencyKey: "as-reader" },
          { signal },
        ),
      ).rejects.toThrow();
    },
    { maxInvitedAccess: "send" },
  );
});

it("stops nothing on an equal access write or a role upgrade, and every session on a role downgrade", async ({
  signal,
}) => {
  await withInvitedGuestGateway(
    signal,
    async (fixture) => {
      const replies = holdReplies(fixture);
      const first = await sharedSession(fixture, signal, "First");
      const second = await sharedSession(fixture, signal, "Second");
      await startHeld(fixture, signal, "invited", first, "hold-first");
      await startHeld(fixture, signal, "invited", second, "hold-second");
      await until(() => replies.held("hold-first") && replies.held("hold-second"), "runs");

      await fixture.sender.request(
        "session.members.setAccess",
        { agentId: "main", sessionKey: first, identityId: fixture.carol.id, access: "send" },
        { signal },
      );
      await fixture.sender.request(
        "users.setRole",
        { profileId: fixture.carol.id, role: "administrator" },
        { signal },
      );
      expect(aborted(fixture, "hold-first")).toBeUndefined();
      expect(aborted(fixture, "hold-second")).toBeUndefined();

      await fixture.sender.request(
        "users.setRole",
        { profileId: fixture.carol.id, role: "guest" },
        { signal },
      );
      for (const runId of ["hold-first", "hold-second"]) {
        expect(aborted(fixture, runId)).toMatchObject({ stopReason: "access-reduced" });
      }
    },
    { maxInvitedAccess: "send" },
  );
});
