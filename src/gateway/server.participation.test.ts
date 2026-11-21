import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { retainEmbeddedSessionPromptState } from "../agents/embedded-agent-runner/session-prompt-state.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";

function providerToolNames(body: string) {
  return (JSON.parse(body) as { tools: { name: string }[] }).tools
    .map(({ name }) => name)
    .toSorted();
}

const creatorTools = ["exec", "ls", "message", "process", "read", "sessions_spawn", "skills_read"];

it("retains exact invitation access through turns, patches, and creator-reviewed exec", async ({
  signal,
}) => {
  const waiting = createDeferred<unknown>();
  const requested = createDeferred<{ id: string; request: unknown; canDecide?: boolean }>();
  const toolOutputs: unknown[] = [];
  await withInvitedGuestGateway(
    signal,
    async ({
      sender,
      invited,
      carol,
      alice,
      providerRequests,
      providerReplies,
      state,
      gateway,
      headers,
      tlsFingerprint,
      origin,
      events,
    }) => {
      const { key, sessionId } = await sender.request<{ key: string; sessionId: string }>(
        "sessions.create",
        {
          agentId: "main",
          label: "Participation regression",
          visibility: "shared",
          permissionMode: "full",
        },
        { signal },
      );
      const sibling = await sender.request<{ key: string }>(
        "sessions.create",
        { agentId: "main", label: "Uninvited sibling", visibility: "shared" },
        { signal },
      );
      const target = { sessionKey: key, agentId: "main" };
      // Retain the same prompt owner across creator → participant → creator requests.
      using promptOwner = retainEmbeddedSessionPromptState(sessionId);
      void promptOwner;
      const creatorTurn = async (runId: string, client = sender) => {
        await client.request(
          "chat.send",
          { ...target, message: runId, idempotencyKey: runId },
          { signal },
        );
        await expect(client.request("agent.wait", { runId }, { signal })).resolves.toMatchObject({
          status: "ok",
        });
        return providerToolNames(providerRequests.at(-1)!);
      };
      const originalTools = await creatorTurn("creator-before-participation");
      expect(originalTools).toEqual(creatorTools);
      const suggest = (sessionKey = key) =>
        invited.request(
          "session.suggestions.add",
          { ...target, sessionKey, text: "Participant suggestion" },
          { signal },
        );
      const access = (level: "read" | "suggest" | "send") =>
        sender.request(
          "session.members.setAccess",
          { ...target, identityId: carol.id, access: level },
          { signal },
        );
      await expect(suggest()).rejects.toThrow();
      await sender.request(
        "session.members.add",
        { ...target, identityId: carol.id, access: "read" },
        { signal },
      );
      await expect(suggest()).rejects.toThrow();
      const sessions = await invited.request<{ sessions: { key: string }[] }>(
        "sessions.list",
        { agentId: "main" },
        { signal },
      );
      expect(sessions.sessions.map((session) => session.key)).toEqual([key]);
      await expect(invited.request("chat.history", target, { signal })).resolves.toMatchObject({
        sessionInfo: { permissionMode: "full" },
      });
      await access("suggest");
      await expect.soft(suggest()).resolves.toMatchObject({ suggestion: { state: "pending" } });
      const listed = await invited.request<{ suggestions: { text: string }[] }>(
        "session.suggestions.list",
        target,
        { signal },
      );
      expect.soft(listed.suggestions.map(({ text }) => text)).toEqual(["Participant suggestion"]);
      await expect(suggest(sibling.key)).rejects.toThrow();
      await expect(suggest("agent:main:missing")).rejects.toThrow();
      await expect(
        invited.request(
          "chat.send",
          { ...target, message: "Not yet", idempotencyKey: "suggest-only" },
          { signal },
        ),
      ).rejects.toThrow();
      await access("send");
      const sending = invited.request(
        "chat.send",
        {
          ...target,
          message: "Respond to the invited participant.",
          idempotencyKey: "participation-send",
        },
        { signal },
      );
      await expect.soft(sending).resolves.toMatchObject({ runId: "participation-send" });
      if (
        await sending.then(
          () => true,
          () => false,
        )
      ) {
        const finished = await sender.request(
          "agent.wait",
          { runId: "participation-send" },
          { signal },
        );
        expect.soft(finished).toMatchObject({ status: "ok" });
      }
      expect
        .soft(providerRequests.some((body) => body.includes("Respond to the invited participant.")))
        .toBe(true);
      expect
        .soft(providerToolNames(providerRequests.at(-1)!))
        .toEqual(["exec", "ls", "process", "read", "sessions_spawn"]);
      await expect
        .soft(
          invited.request(
            "sessions.patch",
            { key, agentId: "main", permissionMode: "read-only" },
            { signal },
          ),
        )
        .resolves.toMatchObject({ ok: true });
      const history = await sender.request("chat.history", target, { signal });
      expect.soft(history).toMatchObject({ sessionInfo: { permissionMode: "read-only" } });
      await expect(
        invited.request("sessions.patch", { key, permissionMode: "full" }, { signal }),
      ).rejects.toThrow();
      await access("read");
      await expect(suggest()).rejects.toThrow();
      await expect(
        invited.request(
          "chat.send",
          { ...target, message: "Revoked", idempotencyKey: "read-only-send" },
          { signal },
        ),
      ).rejects.toThrow();

      // The creator starts Full work as admin, then reviews as a non-admin named role.
      await sender.request("sessions.patch", { key, permissionMode: "full" }, { signal });
      await access("send");
      setUserProfileRole(alice.id, "creator");
      const creator = await connectGatewayClient({
        signal,
        url: `wss://127.0.0.1:${gateway.port}`,
        tlsFingerprint,
        origin,
        edgeAuthHeaders: headers("alice@committed-mention.example.test"),
        clientName: "openclaw-control-ui",
        mode: "webchat",
        scopes: ["operator.read", "operator.write"],
        caps: [GATEWAY_CLIENT_CAPS.APPROVALS],
        deviceIdentity: loadOrCreateDeviceIdentity({
          path: state.path("creator-device", "client", "credentials.sqlite"),
        }),
        onEvent: (event) => {
          if (event.event === "exec.approval.requested" && isRecord(event.payload)) {
            requested.resolve(
              event.payload as { id: string; request: unknown; canDecide?: boolean },
            );
          }
        },
      });
      try {
        await invited.request(
          "sessions.messages.subscribe",
          { key, includeApprovals: true },
          { signal },
        );
        let issued = false;
        providerReplies.reply = (body, response) => {
          const input = (JSON.parse(body) as { input: { type?: string; output?: unknown }[] })
            .input;
          toolOutputs.push(
            ...input
              .filter((item) => item.type === "function_call_output")
              .map((item) => item.output),
          );
          if (!issued) {
            issued = true;
            writeToolCall(response, "exec", {
              command: "printf participant-exec-proof",
              host: "gateway",
              awaitResults: true,
            });
          } else {
            writeOpenAiResponsesText(response, {
              text: "Exec proof complete.",
              messageId: "exec-reply",
              responseId: "exec-response",
            });
          }
        };
        await invited.request(
          "chat.send",
          {
            ...target,
            message: "Run the exec proof.",
            idempotencyKey: "participation-exec",
          },
          { signal },
        );
        const terminal = creator.request("agent.wait", { runId: "participation-exec" }, { signal });
        const approval = await awaitGateBeforeSettlement(
          requested.promise,
          terminal,
          "Exec ended before registering its creator approval",
        );
        expect(approval).toMatchObject({
          canDecide: true,
          request: {
            command: "printf participant-exec-proof",
            security: "allowlist",
            ask: "on-miss",
            turnActor: { id: carol.id },
          },
        });
        expect(
          await awaitGateBeforeSettlement(
            waiting.promise,
            terminal,
            "Participant waiting status missing",
          ),
        ).toMatchObject({ phase: "participant", status: "pending", approvalId: approval.id });
        expect(events.invited.some((event) => event.event === "exec.approval.requested")).toBe(
          false,
        );
        for (const method of ["exec.approval.resolve", "approval.resolve"]) {
          await expect(
            invited.request(method, { id: approval.id, decision: "allow-once" }, { signal }),
          ).rejects.toThrow();
        }
        for (const method of [
          "exec.approval.waitDecision",
          "exec.approval.get",
          "exec.approval.list",
        ]) {
          await expect(invited.request(method, { id: approval.id }, { signal })).rejects.toThrow(
            "missing scope",
          );
        }
        await expect(
          invited.request(
            "exec.approval.request",
            {
              command: "printf forged",
              sessionKey: key,
              runId: "participation-exec",
              twoPhase: true,
            },
            { signal },
          ),
        ).rejects.toThrow("missing scope");
        await creator.request(
          "exec.approval.resolve",
          { id: approval.id, decision: "allow-once" },
          { signal },
        );
        await expect(terminal).resolves.toMatchObject({ status: "ok" });
        expect(toolOutputs).toEqual([expect.stringMatching(/(?:^|\n)participant-exec-proof$/u)]);
        expect
          .soft(providerToolNames(providerRequests.at(-1)!))
          .toEqual(["exec", "ls", "process", "read", "sessions_spawn"]);
        providerReplies.reply = undefined;
        expect(await creatorTurn("creator-after-participation", creator)).toEqual(originalTools);
      } finally {
        await disconnectGatewayClient(creator);
      }
    },
    {
      invitedScopes: ["operator.sessions.read"],
      maxInvitedAccess: "send",
      tools: {
        allow: creatorTools,
        codeMode: { enabled: false },
        toolSearch: false,
        exec: { host: "gateway", security: "full", ask: "off" },
      },
      onInvitedEvent: (event) => {
        if (
          event.event === "session.approval" &&
          isRecord(event.payload) &&
          event.payload.phase === "participant"
        ) {
          waiting.resolve(event.payload);
        }
      },
    },
  );
});

it("serializes the exact invited tool ceiling without leaking it into creator or sibling turns", async ({
  signal,
}) => {
  await withInvitedGuestGateway(
    signal,
    async ({ sender, invited, carol, providerRequests, providerReplies }) => {
      const shared = await sender.request<{ key: string; sessionId: string }>(
        "sessions.create",
        {
          agentId: "main",
          label: "Narrow participation",
          visibility: "shared",
          permissionMode: "full",
        },
        { signal },
      );
      const sibling = await sender.request<{ key: string; sessionId: string }>(
        "sessions.create",
        {
          agentId: "main",
          label: "Independent creator",
          permissionMode: "full",
        },
        { signal },
      );
      using sharedOwner = retainEmbeddedSessionPromptState(shared.sessionId);
      void sharedOwner;
      using siblingOwner = retainEmbeddedSessionPromptState(sibling.sessionId);
      void siblingOwner;
      await sender.request(
        "session.members.add",
        {
          sessionKey: shared.key,
          agentId: "main",
          identityId: carol.id,
          access: "send",
        },
        { signal },
      );
      const turn = async (client: typeof sender, key: string, runId: string) => {
        const start = providerRequests.length;
        await client.request(
          "chat.send",
          {
            sessionKey: key,
            message: runId,
            idempotencyKey: runId,
          },
          { signal },
        );
        await expect(sender.request("agent.wait", { runId }, { signal })).resolves.toMatchObject({
          status: "ok",
        });
        const requests = providerRequests.slice(start);
        expect(requests.length).toBeGreaterThan(0);
        return requests;
      };
      const original = await turn(sender, shared.key, "narrow-creator-before");
      const originalTools = providerToolNames(original[0]!);
      expect(originalTools).toEqual([
        "dispatch_action",
        "exec",
        "ls",
        "message",
        "process",
        "read",
        "tool_describe",
        "tool_search",
      ]);
      let issued = false;
      providerReplies.reply = (_body, response) => {
        if (!issued) {
          issued = true;
          // A provider can still emit a removed tool name; it must not reach an executor.
          writeToolCall(response, "exec", {
            command: "printf forbidden-exec-ran",
            host: "gateway",
            awaitResults: true,
          });
        } else {
          writeOpenAiResponsesText(response, {
            text: "Unavailable tool refused.",
            messageId: "narrow-reply",
            responseId: "narrow-response",
          });
        }
      };
      const narrowed = await turn(invited, shared.key, "narrow-participant");
      for (const body of narrowed) {
        expect.soft(providerToolNames(body)).toEqual(["ls", "read"]);
      }
      const outputs = (
        JSON.parse(narrowed.at(-1)!) as { input: { type?: string; output?: string }[] }
      ).input
        .filter((item) => item.type === "function_call_output")
        .map((item) => item.output);
      expect(outputs).toHaveLength(1);
      expect(outputs[0]).toMatch(/not found|not available|outside the tools/i);
      expect(outputs[0]).not.toBe("forbidden-exec-ran");
      providerReplies.reply = undefined;
      expect(providerToolNames((await turn(sender, sibling.key, "narrow-sibling"))[0]!)).toEqual(
        originalTools,
      );
      expect(
        providerToolNames((await turn(sender, shared.key, "narrow-creator-after"))[0]!),
      ).toEqual(originalTools);
      expect(
        providerToolNames((await turn(invited, shared.key, "narrow-participant-again"))[0]!),
      ).toEqual(["ls", "read"]);
    },
    {
      invitedScopes: ["operator.sessions.read"],
      maxInvitedAccess: "send",
      invitedTools: ["read", "ls"],
      tools: {
        allow: creatorTools,
        codeMode: false,
        toolSearch: true,
        exec: { host: "gateway", security: "full", ask: "off" },
      },
    },
  );
});
