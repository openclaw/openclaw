import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createGatewaySession } from "./session-create-service.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

describe("Gateway creation preparation", () => {
  it.each(["sessions.send", "sessions.create", "generated-create"])(
    "transfers only the creation owner's exact committed row into the original %s lease",
    async (method) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const client = roleClient("view", "creation-caller");
        client.connect.scopes = ["operator.sessions.write"];
        const profileId = client.authenticatedUserProfile!.profileId;
        const cfg = rolePolicyConfig();
        const key = "agent:main:created-handoff";
        const generated = method === "generated-create";
        const captured = resolveSessionMutationAuthorization({
          client,
          context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
          method: generated ? "sessions.create" : method,
          requestParams: generated ? {} : { key },
          sessionScope: "operator.sessions.write",
        });
        expect(captured.error).toBeNull();
        const authorization = captured.authorization!;
        const notify = vi.fn<
          NonNullable<Parameters<typeof createGatewaySession>[0]["onCreatedSessionCommitted"]>
        >((created) => {
          expect(
            loadSessionEntry({ agentId: created.agentId, sessionKey: created.key }),
          ).toMatchObject({
            sessionId: created.entry.sessionId,
            lifecycleRevision: created.entry.lifecycleRevision,
          });
          authorization.recordCreatedSession?.({
            agentId: created.agentId,
            sessionKey: created.key,
            storePath: created.storePath,
            sessionId: created.entry.sessionId,
            lifecycleRevision: created.entry.lifecycleRevision,
          });
        });
        const afterCreate = vi.fn<
          NonNullable<Parameters<typeof createGatewaySession>[0]["afterCreate"]>
        >(async (created) => {
          expect(notify).toHaveBeenCalledOnce();
          expect(() => authorization.assertCurrent()).not.toThrow();
          const scope = {
            agentId: created.agentId,
            sessionKey: created.key,
            storePath: created.storePath,
          };
          replaceSessionEntrySync(scope, { ...created.entry, lifecycleRevision: "replacement" });
          // A second notification cannot adopt a successor after the first COMMIT.
          authorization.recordCreatedSession?.({
            agentId: created.agentId,
            sessionKey: created.key,
            storePath: created.storePath,
            sessionId: created.entry.sessionId,
            lifecycleRevision: "replacement",
          });
          expect(() => authorization.assertCurrent()).toThrow("session changed");
        });
        const created = await createGatewaySession({
          cfg,
          ...(generated ? {} : { key }),
          commandSource: "test",
          requestingOperatorScopes: client.connect.scopes,
          requestingOperatorProfileId: profileId,
          operatorRoleActor: { kind: "operator", profileId },
          creation: { via: "operator", actor: { type: "human", source: "profile", id: profileId } },
          commitGuard: authorization.assertCurrent,
          onCreatedSessionCommitted: notify,
          afterCreate,
        });
        expect(created.ok).toBe(true);
        expect(notify).toHaveBeenCalledOnce();
        expect(afterCreate).toHaveBeenCalledOnce();
      });
    },
  );

  it.each(["sessionRoot", "spawnedCwd"] as const)(
    "keeps an explicit %s when forking",
    async (destination) => {
      await withOpenClawTestState({ label: "gateway-fork-destination" }, async (state) => {
        const parentRoot = state.path("parent-project");
        const childRoot = state.path("selected-folder");
        await fs.mkdir(parentRoot);
        await fs.mkdir(childRoot);
        const common = {
          cfg: {},
          commandSource: "test",
          operatorRoleActor: { kind: "system" as const },
        };
        const parent = await createGatewaySession({
          ...common,
          key: "agent:main:parent",
          projectId: "parent-project",
          spawnedCwd: parentRoot,
          sessionRoot: parentRoot,
        });
        expect(parent.ok).toBe(true);
        const child = await createGatewaySession({
          ...common,
          key: "agent:main:child",
          parentSessionKey: "agent:main:parent",
          fork: true,
          [destination]: childRoot,
        });
        expect(child).toMatchObject({ ok: true, entry: { [destination]: childRoot } });
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: "agent:main:child" })?.projectId,
        ).toBeUndefined();
      });
    },
  );
  it("retains the full adopted target while checking sibling labels", async () => {
    await withOpenClawTestState({ label: "gateway-create-snapshot" }, async () => {
      const create = (key: string, label: string) =>
        createGatewaySession({
          cfg: {},
          key,
          label,
          commandSource: "test",
          operatorRoleActor: { kind: "system" },
        });
      const first = await create("agent:main:target", "Original");
      expect(first.ok).toBe(true);
      const scope = { agentId: "main", sessionKey: "agent:main:target" };
      const initial = loadSessionEntry(scope);
      if (!initial) {
        throw new Error("Missing initial session");
      }
      const saved = {
        ...initial,
        skillsSnapshot: { prompt: "Saved skill prompt", skills: [] },
        systemPromptReport: {
          source: "run" as const,
          generatedAt: 1,
          systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 0, entries: [] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        },
      };
      replaceSessionEntrySync(scope, saved);
      expect((await create("agent:main:sibling", "Taken")).ok).toBe(true);
      expect(await create(scope.sessionKey, "Renamed")).toMatchObject({
        ok: true,
        entry: { sessionId: saved.sessionId, label: "Renamed" },
      });
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: saved.sessionId,
        label: "Renamed",
        skillsSnapshot: saved.skillsSnapshot,
        systemPromptReport: saved.systemPromptReport,
      });
      expect(await create(scope.sessionKey, "Taken")).toMatchObject({
        ok: false,
        error: { message: "label already in use: Taken" },
      });
      expect(loadSessionEntry(scope)).toMatchObject({
        sessionId: saved.sessionId,
        label: "Renamed",
        skillsSnapshot: saved.skillsSnapshot,
        systemPromptReport: saved.systemPromptReport,
      });
    });
  });
});
