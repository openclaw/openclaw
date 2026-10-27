import { expect, it } from "vitest";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";

it("grants and revokes authenticated guest access without replaying an invitation", async ({
  signal,
}) => {
  await withInvitedGuestGateway(signal, async ({ gateway, sender, alice, bob }) => {
    const created = await sender.request<{ key: string }>(
      "sessions.create",
      { agentId: "main" },
      { signal },
    );
    const target = created.key;
    const own = await gateway.client.request<{ key: string }>(
      "sessions.create",
      { agentId: "main" },
      { signal },
    );
    const visibleKeys = async () =>
      (
        await gateway.client.request<{ sessions: { key: string }[] }>(
          "sessions.list",
          {
            agentId: "main",
          },
          { signal },
        )
      ).sessions.map((session) => session.key);
    const readTarget = () =>
      gateway.client.request("chat.history", { sessionKey: target }, { signal });
    expect(await visibleKeys()).toContain(own.key);
    expect(await visibleKeys()).not.toContain(target);
    await expect(readTarget()).rejects.toThrow();
    const seed = await sender.request<{ runId: string }>(
      "chat.send",
      {
        sessionKey: target,
        message: "Start this conversation.",
        idempotencyKey: "mention-seed",
      },
      { signal },
    );
    expect(
      await sender.request("agent.wait", { runId: seed.runId, timeoutMs: 30_000 }, { signal }),
    ).toMatchObject({ status: "ok" });
    const lookup = await sender.request<{ users: { profileId: string }[] }>(
      "users.mentionable",
      {
        sessionKey: target,
        query: "Bob",
      },
      { signal },
    );
    expect(lookup.users.map((profile) => profile.profileId)).toContain(bob.id);
    const request = {
      sessionKey: target,
      message: "@Bob Please review.",
      idempotencyKey: "mention-original",
      mentions: [{ profileId: bob.id, start: 0, end: 4 }],
    };
    const accepted = await sender.request<{ runId: string; messageSeq: number }>(
      "chat.send",
      request,
      { signal },
    );
    expect(accepted.messageSeq).toBeGreaterThan(0);
    expect(
      await sender.request("agent.wait", { runId: accepted.runId, timeoutMs: 30_000 }, { signal }),
    ).toMatchObject({ status: "ok" });
    expect(await visibleKeys()).toEqual(expect.arrayContaining([own.key, target]));
    const history = await gateway.client.request<{ messages: unknown[] }>(
      "chat.history",
      {
        sessionKey: target,
      },
      { signal },
    );
    expect(history.messages).toContainEqual(
      expect.objectContaining({ role: "user", content: request.message }),
    );
    const inbox = await gateway.client.request<{ items: unknown[] }>(
      "mentions.list",
      {},
      { signal },
    );
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({
      sessionKey: target,
      senderProfileId: alice.id,
      excerpt: request.message,
    });
    const replay = await sender.request<{ runId: string }>("chat.send", request, { signal });
    expect(replay.runId).toBe(accepted.runId);
    expect(
      (await gateway.client.request<{ items: unknown[] }>("mentions.list", {}, { signal })).items,
    ).toEqual(inbox.items);
    await sender.request(
      "session.members.remove",
      { sessionKey: target, identityId: bob.id },
      { signal },
    );
    expect(await visibleKeys()).not.toContain(target);
    await expect(readTarget()).rejects.toThrow();
    await sender.request("chat.send", request, { signal });
    expect(await visibleKeys()).not.toContain(target);
    await expect(readTarget()).rejects.toThrow();
  });
});
