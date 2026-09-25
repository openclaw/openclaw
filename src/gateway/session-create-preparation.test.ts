import fs from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  beginSessionWorkAdmission,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { createGatewaySession } from "./session-create-service.js";
import { resolveSessionMutationAuthorization } from "./session-sharing.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils.js";

describe("Gateway creation preparation", () => {
  it.each(["canonical", "alias", "sessionId", "embedded"] as const)(
    "rejects workspace preparation before allocation while %s owns active work",
    async (identity) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const key = "agent:main:main";
        const originalRoot = state.path("original");
        const destination = state.path("worktree");
        const common = {
          cfg: {},
          key: "main",
          commandSource: "test",
          operatorRoleActor: { kind: "system" as const },
        };
        const first = await createGatewaySession({ ...common, sessionRoot: originalRoot });
        expect(first.ok).toBe(true);
        if (!first.ok) {
          throw new Error(first.error.message);
        }
        const scope = { ...resolveGatewaySessionStoreTarget({ cfg: {}, key }), sessionKey: key };
        const transcriptScope = { ...scope, sessionId: first.entry.sessionId };
        for (const message of [
          { role: "user", content: "Keep this conversation when moving the workspace." },
          { role: "assistant", content: "The conversation stays with this session." },
        ]) {
          expect(await appendTranscriptMessage(transcriptScope, { message })).toMatchObject({
            appended: true,
          });
        }
        const transcript = await loadTranscriptEvents(transcriptScope);
        const onInterrupt = vi.fn();
        const handle = {
          abort: onInterrupt,
          cancel: onInterrupt,
          isStreaming: () => true,
          isCompacting: () => false,
          queueMessage: async () => {},
        };
        const admission =
          identity === "embedded"
            ? undefined
            : await beginSessionWorkAdmission({
                scope: scope.storePath,
                identities: [
                  identity === "sessionId"
                    ? first.entry.sessionId
                    : identity === "alias"
                      ? "main"
                      : key,
                ],
                assertAllowed: () => {},
                onInterrupt,
              });
        if (identity === "embedded") {
          setActiveEmbeddedRun(first.entry.sessionId, handle, key);
        }
        const prepareLifecycle = vi.fn(async () => ({
          ok: true as const,
          value: { sessionRoot: destination, spawnedCwd: destination },
        }));
        try {
          expect(await createGatewaySession({ ...common, prepareLifecycle })).toMatchObject({
            ok: false,
            error: { code: "UNAVAILABLE", message: expect.stringContaining("still active") },
          });
          expect(prepareLifecycle).not.toHaveBeenCalled();
          expect(loadSessionEntry(scope)).toMatchObject({
            sessionId: first.entry.sessionId,
            sessionRoot: originalRoot,
          });
          expect(onInterrupt).not.toHaveBeenCalled();
          expect(admission?.isActive() ?? isEmbeddedAgentRunActive(first.entry.sessionId)).toBe(
            true,
          );
          expect(
            await createGatewaySession({ ...common, sessionRoot: originalRoot }),
          ).toMatchObject({
            ok: true,
            entry: { sessionId: first.entry.sessionId, sessionRoot: originalRoot },
          });
        } finally {
          admission?.release();
          if (identity === "embedded") {
            clearActiveEmbeddedRun(first.entry.sessionId, handle, key);
          }
        }
        expect(await createGatewaySession({ ...common, prepareLifecycle })).toMatchObject({
          ok: true,
          entry: {
            sessionId: first.entry.sessionId,
            sessionRoot: destination,
            spawnedCwd: destination,
          },
        });
        expect(await loadTranscriptEvents(transcriptScope)).toEqual(transcript);
      });
    },
  );

  it("rejects a target identity change while waiting for lifecycle custody", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const key = "agent:main:workspace-drift";
      const common = {
        cfg: {},
        key,
        commandSource: "test",
        operatorRoleActor: { kind: "system" as const },
      };
      const first = await createGatewaySession(common);
      expect(first.ok).toBe(true);
      if (!first.ok) {
        throw new Error(first.error.message);
      }
      const target = resolveGatewaySessionStoreTarget({ cfg: {}, key });
      const scope = { agentId: target.agentId, sessionKey: key, storePath: target.storePath };
      const entered = createDeferredCore();
      const rotate = createDeferredCore();
      const mutation = runExclusiveSessionLifecycleMutation({
        scope: target.storePath,
        identities: [key, first.entry.sessionId],
        run: async () => {
          entered.resolve();
          await rotate.promise;
          replaceSessionEntrySync(scope, { ...first.entry, sessionId: "replacement-session" });
        },
      });
      await entered.promise;
      const prepareLifecycle = vi.fn(async () => ({
        ok: true as const,
        value: { sessionRoot: state.path("worktree") },
      }));
      const adoption = createGatewaySession({ ...common, prepareLifecycle });
      rotate.resolve();
      try {
        await mutation;
        expect(await adoption).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE", message: expect.stringContaining("changed before") },
        });
        expect(prepareLifecycle).not.toHaveBeenCalled();
        expect(loadSessionEntry(scope)?.sessionId).toBe("replacement-session");
      } finally {
        rotate.resolve();
        await Promise.allSettled([mutation, adoption]);
      }
    });
  });

  it.each(["sessionRoot", "spawnedCwd", "execNode"] as const)(
    "rejects an active target's changed %s without a preparation callback",
    async (binding) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const key = "agent:main:direct-binding";
        const common = {
          cfg: {},
          key,
          commandSource: "test",
          operatorRoleActor: { kind: "system" as const },
        };
        const first = await createGatewaySession(common);
        expect(first.ok).toBe(true);
        const target = resolveGatewaySessionStoreTarget({ cfg: {}, key });
        const admission = await beginSessionWorkAdmission({
          scope: target.storePath,
          identities: [key],
          assertAllowed: () => {},
        });
        try {
          const value = binding === "execNode" ? "selected-node" : "/selected-workspace";
          expect(await createGatewaySession({ ...common, [binding]: value })).toMatchObject({
            ok: false,
            error: { code: "UNAVAILABLE", message: expect.stringContaining("still active") },
          });
        } finally {
          admission.release();
        }
      });
    },
  );

  it.each(["commit", "rollback"] as const)(
    "holds queued admission through workspace %s while unrelated work progresses",
    async (outcome) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const key = "agent:main:workspace-target";
        const originalRoot = state.path("original");
        const destination = state.path("worktree");
        const common = {
          cfg: {},
          key,
          commandSource: "test",
          operatorRoleActor: { kind: "system" as const },
        };
        const first = await createGatewaySession({ ...common, sessionRoot: originalRoot });
        expect(first.ok).toBe(true);
        if (!first.ok) {
          throw new Error(first.error.message);
        }
        expect(
          (await createGatewaySession({ ...common, key: "agent:main:sibling", label: "Taken" })).ok,
        ).toBe(true);
        const target = resolveGatewaySessionStoreTarget({ cfg: {}, key });
        const scope = { agentId: target.agentId, sessionKey: key, storePath: target.storePath };
        const entered = createDeferredCore();
        const proceed = createDeferredCore();
        const rollingBack = createDeferredCore();
        const finishRollback = createDeferredCore();
        const creation = createGatewaySession({
          ...common,
          ...(outcome === "rollback" ? { label: "Taken" } : {}),
          prepareLifecycle: async () => {
            entered.resolve();
            await proceed.promise;
            return {
              ok: true,
              value: {
                sessionRoot: destination,
                rollback: async () => {
                  rollingBack.resolve();
                  await finishRollback.promise;
                },
              },
            };
          },
        });
        await Promise.race([
          entered.promise,
          creation.then((result) => {
            throw new Error(`Creation completed before preparation: ${JSON.stringify(result)}`);
          }),
        ]);
        const observedRoots: Array<string | undefined> = [];
        const queued = beginSessionWorkAdmission({
          scope: target.storePath,
          identities: [first.entry.sessionId],
          assertAllowed: () => {
            observedRoots.push(loadSessionEntry(scope)?.sessionRoot);
          },
        });
        try {
          const unrelated = await beginSessionWorkAdmission({
            scope: target.storePath,
            identities: ["agent:main:sibling"],
            assertAllowed: () => {},
          });
          unrelated.release();
          expect(observedRoots).toEqual([]);
          proceed.resolve();
          if (outcome === "rollback") {
            await Promise.race([
              rollingBack.promise,
              creation.then((result) => {
                throw new Error(`Creation completed before rollback: ${JSON.stringify(result)}`);
              }),
            ]);
            expect(observedRoots).toEqual([]);
          }
          finishRollback.resolve();
          expect(await creation).toMatchObject({ ok: outcome === "commit" });
          const admitted = await queued;
          admitted.release();
          expect(new Set(observedRoots)).toEqual(
            new Set([outcome === "commit" ? destination : originalRoot]),
          );
          expect(loadSessionEntry(scope)?.sessionId).toBe(first.entry.sessionId);
        } finally {
          proceed.resolve();
          finishRollback.resolve();
          await Promise.allSettled([creation, queued.then((admitted) => admitted.release())]);
        }
      });
    },
  );

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
