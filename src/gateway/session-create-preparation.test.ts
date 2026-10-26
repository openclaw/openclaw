import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  beginSessionEffect,
  runSessionMutation,
} from "../sessions/session-controller.lifecycle.js";
import { isSessionRunActive } from "../sessions/session-controller.queries.js";
import { createDeferredCore } from "../shared/deferred.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import * as repositoryWorkspaces from "../state/session-repository-workspaces.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { prepareSessionRepositoryWorkspace } from "./server-methods/session-create-project.js";
import { createGatewaySession } from "./session-create-service.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import { resolveGatewaySessionStoreTargetInWorker } from "./session-utils-store-worker.js";

const withState: typeof withOpenClawTestState = (options, run) =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true, ...options }, run);
type Creation = Parameters<typeof createGatewaySession>[0];
const createSession = (params: Omit<Creation, "commandSource" | "operatorRoleActor" | "cfg">) =>
  createGatewaySession({
    cfg: {},
    commandSource: "test",
    operatorRoleActor: { kind: "system" },
    ...params,
  });
type Created = Parameters<NonNullable<Creation["onCreatedSessionCommitted"]>>[0];
const scopeOf = ({ key, agentId, storePath }: Pick<Created, "key" | "agentId" | "storePath">) => ({
  agentId,
  sessionKey: key,
  storePath,
});
const receiptOf = (created: Created, entry = created.entry) => ({
  ...scopeOf(created),
  sessionId: entry.sessionId,
  lifecycleRevision: entry.lifecycleRevision,
  entry,
});
const preparedRoot = (sessionRoot: string, spawnedCwd?: string) =>
  vi.fn(async () => ({ ok: true as const, value: { sessionRoot, spawnedCwd } }));
const unavailable = (message: string) => ({
  ok: false,
  error: { code: "UNAVAILABLE", message: expect.stringContaining(message) },
});
async function setupCreationTarget(key: string, sessionRoot?: string, requestKey = key) {
  const create = (params: Omit<Parameters<typeof createSession>[0], "key"> = {}) =>
    createSession({ key: requestKey, ...params });
  const first = await create({ sessionRoot });
  assert(first.ok);
  const target = await resolveGatewaySessionStoreTargetInWorker({ cfg: {}, key });
  return { create, first, target, scope: scopeOf({ ...target, key }) };
}

it.each(["caller", "database"] as const)(
  "keeps repository creation compensation bound to its original source after %s retirement",
  (retired) =>
    withState({}, async (state) => {
      const store = repositoryWorkspaces.getSessionRepositoryWorkspaceStore();
      using spies = new DisposableStack();
      spies.use(
        vi.spyOn(repositoryWorkspaces, "getSessionRepositoryWorkspaceStore").mockReturnValue(store),
      );
      const create = store.create.bind(store);
      let current = true;
      spies.use(
        vi.spyOn(store, "create").mockImplementationOnce(async (input) => {
          const created = await create(input);
          const artifact = store.artifactPath(created.workspaceId);
          await fs.mkdir(artifact, { recursive: true });
          await fs.writeFile(path.join(artifact, "retained-owner"), "accepted target");
          if (retired === "database") {
            await closeOpenClawStateDatabaseByPathAsync(store.path);
          } else {
            current = false;
          }
          return created;
        }),
      );
      const owner = { agentId: "main", sessionKey: "agent:main:creation-compensation" };
      const result = await prepareSessionRepositoryWorkspace(
        { url: "https://github.com/openclaw/fixture.git" },
        {
          runSetupScript: false,
          assertCurrent: () => {
            if (!current) {
              throw new Error("creation caller revoked");
            }
          },
        },
      )({
        agentId: owner.agentId,
        key: owner.sessionKey,
        storePath: state.path("sessions.sqlite"),
      });
      assert(result.ok && result.value.rollback && result.value.repositoryWorkspaceId);
      const workspaceId = result.value.repositoryWorkspaceId;
      const persisted = await store.get(workspaceId);
      expect(persisted).toMatchObject({ workspaceId, ...owner });
      if (retired === "database") {
        await expect(result.value.rollback()).rejects.toBeInstanceOf(
          StateDatabaseReadAdmissionInvalidatedError,
        );
        expect(await store.get(workspaceId)).toEqual(persisted);
        expect(
          await fs.readFile(path.join(store.artifactPath(workspaceId), "retained-owner"), "utf8"),
        ).toBe("accepted target");
      } else {
        await result.value.rollback();
        expect(await store.get(workspaceId)).toBeUndefined();
        await expect(fs.stat(store.artifactPath(workspaceId))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      assert(result.value.withCommit);
      const commit = vi.fn(async (assertSourceCurrent: () => void) => assertSourceCurrent());
      const publication = result.value.withCommit(commit);
      if (retired === "database") {
        await expect(publication).rejects.toBeInstanceOf(
          StateDatabaseReadAdmissionInvalidatedError,
        );
      } else {
        await expect(publication).rejects.toThrow("creation caller revoked");
      }
      expect(commit).not.toHaveBeenCalled();
    }),
);

it.each([
  ["canonical", undefined],
  ["alias", undefined],
  ["sessionId", undefined],
  ["embedded", undefined],
  ["canonical", "sessionRoot"],
  ["canonical", "spawnedCwd"],
  ["canonical", "execNode"],
] as const)(
  "rejects active %s work before workspace allocation or direct binding (%s)",
  (identity, binding) =>
    withState({}, async (state) => {
      const key = "agent:main:main";
      const originalRoot = state.path("original");
      const destination = state.path("worktree");
      const { create, first, scope } = await setupCreationTarget(key, originalRoot, "main");
      const original = { sessionId: first.entry.sessionId, sessionRoot: originalRoot };
      const transcriptScope = { ...scope, sessionId: first.entry.sessionId };
      expect(
        await appendTranscriptMessage(transcriptScope, {
          message: { role: "user", content: "Keep this conversation when moving the workspace." },
        }),
      ).toMatchObject({ appended: true });
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
          : await beginSessionEffect({
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
      const prepareLifecycle = preparedRoot(destination, destination);
      try {
        expect(
          await create(
            binding
              ? { [binding]: binding === "execNode" ? "selected-node" : destination }
              : { prepareLifecycle },
          ),
        ).toMatchObject(unavailable("still active"));
        expect(prepareLifecycle).not.toHaveBeenCalled();
        expect(loadSessionEntry(scope)).toMatchObject(original);
        expect(onInterrupt).not.toHaveBeenCalled();
        expect(admission?.isActive() ?? isSessionRunActive(first.entry.sessionId)).toBe(true);
        expect(await create({ sessionRoot: originalRoot })).toMatchObject({
          ok: true,
          entry: original,
        });
      } finally {
        admission?.release();
        if (identity === "embedded") {
          clearActiveEmbeddedRun(first.entry.sessionId, handle, key);
        }
      }
      expect(await create({ prepareLifecycle })).toMatchObject({
        ok: true,
        entry: {
          sessionId: first.entry.sessionId,
          sessionRoot: destination,
          spawnedCwd: destination,
        },
      });
      expect(await loadTranscriptEvents(transcriptScope)).toEqual(transcript);
    }),
);

it("rejects a target identity change while waiting for lifecycle custody", () =>
  withState({}, async (state) => {
    const key = "agent:main:workspace-drift";
    const { create, first, target, scope } = await setupCreationTarget(key);
    const entered = createDeferredCore();
    const rotate = createDeferredCore();
    const mutation = runSessionMutation({
      scope: target.storePath,
      identities: [key, first.entry.sessionId],
      run: async () => {
        entered.resolve();
        await rotate.promise;
        replaceSessionEntrySync(scope, { ...first.entry, sessionId: "replacement-session" });
      },
    });
    await entered.promise;
    const prepareLifecycle = preparedRoot(state.path("worktree"));
    const lifecycleAdmission = createDeferredCore();
    const adoption = create({
      prepareLifecycle,
      onPhase: (phase) => {
        if (phase === "lifecycleAdmission") {
          lifecycleAdmission.resolve();
        }
      },
    });
    try {
      await awaitGateBeforeSettlement(lifecycleAdmission.promise, adoption, "lifecycle admission");
      rotate.resolve();
      await mutation;
      expect(await adoption).toMatchObject(unavailable("changed before"));
      expect(prepareLifecycle).not.toHaveBeenCalled();
      expect(loadSessionEntry(scope)?.sessionId).toBe("replacement-session");
    } finally {
      rotate.resolve();
      await Promise.allSettled([mutation, adoption]);
    }
  }));

it.each(["commit", "rollback"] as const)(
  "holds queued admission through workspace %s while unrelated work progresses",
  (outcome) =>
    withState({}, async (state) => {
      const key = "agent:main:workspace-target";
      const originalRoot = state.path("original");
      const destination = state.path("worktree");
      const { create, first, target, scope } = await setupCreationTarget(key, originalRoot);
      expect((await createSession({ key: "agent:main:sibling", label: "Taken" })).ok).toBe(true);
      const entered = createDeferredCore();
      const proceed = createDeferredCore();
      const rollingBack = createDeferredCore();
      const finishRollback = createDeferredCore();
      const creation = create({
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
      await awaitGateBeforeSettlement(entered.promise, creation, "workspace preparation");
      const observedRoots: Array<string | undefined> = [];
      const queued = beginSessionEffect({
        scope: target.storePath,
        identities: [first.entry.sessionId],
        assertAllowed: () => {
          observedRoots.push(loadSessionEntry(scope)?.sessionRoot);
        },
      });
      try {
        const unrelated = await beginSessionEffect({
          scope: target.storePath,
          identities: ["agent:main:sibling"],
          assertAllowed: () => {},
        });
        unrelated.release();
        expect(observedRoots).toEqual([]);
        proceed.resolve();
        if (outcome === "rollback") {
          await awaitGateBeforeSettlement(rollingBack.promise, creation, "workspace rollback");
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
    }),
);

it.each(["sessions.send", "sessions.create", "generated-create", "custom-store-send"])(
  "transfers only the creation owner's exact committed row into the original %s lease",
  (method) =>
    withState({}, async (state) => {
      const client = roleClient("view", "creation-caller");
      client.connect.scopes = ["operator.sessions.write"];
      const profileId = client.authenticatedUserProfile!.profileId;
      const cfg = rolePolicyConfig();
      const customStore = method === "custom-store-send";
      if (customStore) {
        cfg.agents = { entries: { main: {}, orion: {} } };
        cfg.session = { store: state.path("sessions.json") };
        await replaceSessionEntry(
          { agentId: "main", sessionKey: "agent:main:existing", storePath: cfg.session.store },
          { sessionId: "existing-main", updatedAt: 1 },
        );
      }
      const key = `agent:${customStore ? "orion" : "main"}:created-handoff`;
      const generated = method === "generated-create";
      const captured = await resolveSessionMutationAuthorizationAsync({
        client,
        context: createDirectChatContext({ getRuntimeConfig: () => cfg }),
        method: generated ? "sessions.create" : customStore ? "sessions.send" : method,
        requestParams: generated ? {} : { key },
        sessionScope: "operator.sessions.write",
      });
      expect(captured.error).toBeNull();
      const authorization = captured.authorization!;
      const notify = vi.fn<NonNullable<Creation["onCreatedSessionCommitted"]>>((created) => {
        expect(loadSessionEntry(scopeOf(created))).toMatchObject({
          sessionId: created.entry.sessionId,
          lifecycleRevision: created.entry.lifecycleRevision,
        });
        authorization.recordCreatedSession?.(receiptOf(created));
      });
      const afterCreate = vi.fn<NonNullable<Creation["afterCreate"]>>(async (created) => {
        expect(notify).toHaveBeenCalledOnce();
        expect(() => authorization.assertCurrent()).not.toThrow();
        const replacement = { ...created.entry, lifecycleRevision: "replacement" };
        replaceSessionEntrySync(scopeOf(created), replacement);
        authorization.recordCreatedSession?.(receiptOf(created, replacement));
        expect(() => authorization.assertCurrent()).toThrow("session changed");
      });
      const created = await createGatewaySession({
        cfg,
        ...(generated ? {} : { key }),
        commandSource: "test",
        requestingOperatorScopes: client.connect.scopes,
        requestingOperatorProfileId: profileId,
        operatorRoleActor: { kind: "operator", profileId },
        creation: {
          via: "operator",
          actor: { type: "human", source: "profile", id: profileId },
        },
        commitGuard: authorization.assertCurrent,
        bindSharingCreation: (operation) => authorization.bindCreation?.({ key }, operation),
        followSharingRegistration: authorization.followRegistration,
        onCreatedSessionCommitted: notify,
        afterCreate,
      });
      expect(created.ok).toBe(true);
      expect(afterCreate).toHaveBeenCalledOnce();
    }),
);

it.each(["sessionRoot", "spawnedCwd"] as const)(
  "keeps an explicit %s when forking",
  (destination) =>
    withOpenClawTestState({ label: "gateway-fork-destination" }, async (state) => {
      const parentRoot = state.path("parent-project");
      const childRoot = state.path("selected-folder");
      await fs.mkdir(parentRoot);
      await fs.mkdir(childRoot);
      const parent = await createSession({
        key: "agent:main:parent",
        projectId: "parent-project",
        spawnedCwd: parentRoot,
        sessionRoot: parentRoot,
      });
      expect(parent.ok).toBe(true);
      const child = await createSession({
        key: "agent:main:child",
        parentSessionKey: "agent:main:parent",
        fork: true,
        [destination]: childRoot,
      });
      expect(child).toMatchObject({ ok: true, entry: { [destination]: childRoot } });
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: "agent:main:child" })?.projectId,
      ).toBeUndefined();
    }),
);
it("retains the full adopted target while checking sibling labels", () =>
  withOpenClawTestState({ label: "gateway-create-snapshot" }, async () => {
    const create = (key: string, label: string) => createSession({ key, label });
    const first = await create("agent:main:target", "Original");
    expect(first.ok).toBe(true);
    const scope = { agentId: "main", sessionKey: "agent:main:target" };
    assert(first.ok);
    const saved = {
      ...first.entry,
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
    const expected = {
      sessionId: saved.sessionId,
      label: "Renamed",
      skillsSnapshot: saved.skillsSnapshot,
      systemPromptReport: saved.systemPromptReport,
    };
    expect(loadSessionEntry(scope)).toMatchObject(expected);
    expect(await create(scope.sessionKey, "Taken")).toMatchObject({
      ok: false,
      error: { message: "label already in use: Taken" },
    });
    expect(loadSessionEntry(scope)).toMatchObject(expected);
  }));
