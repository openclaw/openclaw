import { expect, it } from "vitest";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";

it("retains exact invitation access through suggestion, turn, and patch settlement", async ({
  signal,
}) => {
  await withInvitedGuestGateway(
    signal,
    async ({ sender, invited, carol, providerRequests }) => {
      const { key } = await sender.request<{ key: string }>(
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
    },
    { invitedScopes: ["operator.sessions.read"], maxInvitedAccess: "send" },
  );
});
