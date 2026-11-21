import { expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { withInvitedGuestGateway } from "./guest-session-access.test-support.js";

it("keeps a hidden child's original invitation ceiling on admin chat, direct agent, reset, and reinvitation", async ({
  signal,
}) => {
  await withInvitedGuestGateway(
    signal,
    async ({ sender, carol, alice, providerRequests, state, model }) => {
      const parent = await sender.request<{ key: string; sessionId: string }>(
        "sessions.create",
        {
          agentId: "main",
          label: "Participant source",
          visibility: "shared",
          permissionMode: "full",
        },
        { signal },
      );
      const access = (value: "send" | "read") =>
        sender.request(
          "session.members.setAccess",
          {
            agentId: "main",
            sessionKey: parent.key,
            identityId: carol.id,
            access: value,
          },
          { signal },
        );
      await sender.request(
        "session.members.add",
        {
          agentId: "main",
          sessionKey: parent.key,
          identityId: carol.id,
          access: "send",
        },
        { signal },
      );
      const source = (await readSessionEntryReadOnlyInWorker({
        agentId: "main",
        sessionKey: parent.key,
      }))!;
      const child = { agentId: "main", sessionKey: "agent:main:subagent:participation-runtime" };
      const ceiling = {
        kind: "send" as const,
        profileId: carol.id,
        sessionKey: parent.key,
        tools: ["read"],
        permission: "read-only" as const,
        source: {
          agentId: "main",
          sessionId: source.sessionId,
          lifecycleRevision: source.lifecycleRevision ?? null,
          creatorProfileId: alice.id,
          root: source.sessionRoot ?? state.workspaceDir,
        },
      };
      await upsertSessionEntryCore(child, {
        sessionId: "participation-runtime-id",
        updatedAt: Date.now(),
        createdActor: { type: "human", source: "profile", id: carol.id },
        parentSessionKey: parent.key,
        spawnedBy: parent.key,
        spawnDepth: 1,
        subagentRole: "leaf",
        permissionMode: "full",
        sessionRoot: state.workspaceDir,
        modelProvider: model.providerId,
        model: model.modelId,
        inheritedToolPolicySource: "participant",
        inheritedToolPolicyVersion: 1,
        inheritedToolAllow: ["read"],
        participationCeiling: ceiling,
      });
      const turn = async (method: "chat.send" | "agent", key: string, runId: string) => {
        const before = providerRequests.length;
        await sender.request(
          method,
          { agentId: "main", sessionKey: key, message: runId, idempotencyKey: runId },
          { signal },
        );
        await expect(sender.request("agent.wait", { runId }, { signal })).resolves.toMatchObject({
          status: "ok",
        });
        const requests = providerRequests.slice(before);
        expect(requests.length).toBeGreaterThan(0);
        return requests.map((body) =>
          (JSON.parse(body) as { tools: { name: string }[] }).tools.map((tool) => tool.name),
        );
      };
      for (const method of ["chat.send", "agent"] as const) {
        expect(await turn(method, child.sessionKey, `child-${method}`)).toEqual([["read"]]);
      }
      await sender.request(
        "sessions.reset",
        { key: child.sessionKey, agentId: "main" },
        { signal },
      );
      expect(await turn("chat.send", child.sessionKey, "child-reset")).toEqual([["read"]]);
      await access("read");
      const beforeRevoked = providerRequests.length;
      await expect(
        sender.request(
          "chat.send",
          {
            ...child,
            message: "do not run",
            idempotencyKey: "child-revoked",
          },
          { signal },
        ),
      ).rejects.toThrow();
      expect(providerRequests).toHaveLength(beforeRevoked);
      await access("send");
      expect(await turn("chat.send", child.sessionKey, "child-reinvited")).toEqual([["read"]]);
      expect((await turn("chat.send", parent.key, "parent-owner"))[0]).toContain("exec");
      expect(
        (await readSessionEntryReadOnlyInWorker({ agentId: "main", sessionKey: parent.key }))
          ?.participationCeiling,
      ).toBeUndefined();
    },
    {
      maxInvitedAccess: "send",
      invitedScopes: ["operator.sessions.read"],
      invitedTools: ["read", "exec"],
      tools: { allow: ["read", "exec"], toolSearch: false, codeMode: { enabled: false } },
    },
  );
});
