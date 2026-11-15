import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { SessionsResolveParams } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { seedCanonicalAcpSessionMeta } from "../acp/runtime/session-meta-fixture.test-support.js";
import * as runtimeOwnership from "../agents/harness/session-runtime-ownership.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  setActivePluginRegistry,
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
} from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../state/openclaw-agent-db.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureUserProfilesSchema } from "../state/user-profiles-schema.js";
import { observeMainThreadReads } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  withOpenClawTestState as withRawTestState,
  withOpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import {
  createArtifactSessionAccess,
  prepareArtifactSessionResolution,
} from "./server-methods/artifacts-session-resolution.js";
import { artifactsHandlers } from "./server-methods/artifacts.js";
import { identifiedClient } from "./server-methods/sessions-read-cache.test-support.js";
import { sessionReadHandlers } from "./server-methods/sessions-read.js";
import type { RespondFn } from "./server-methods/types.js";
import { resolveSessionForRun } from "./server-session-key.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { roleClient, rolePolicyConfig, sharingPolicyClient } from "./session-sharing.test-utils.js";
import {
  filterAndSortSessionEntries,
  listProjectedSessions,
  prepareSessionRowSelection,
} from "./session-utils-list.js";
import * as rowInputs from "./session-utils-row.js";
import {
  withPreparedSessionResolve,
  resolveSessionKeyFromResolveParams,
} from "./sessions-resolve.js";

const resolved = (key: string, agentId = "main") => ({ ok: true, key, agentId });
const runOwner = (sessionKey: string, agentId = "main") => ({ sessionKey, agentId });
const missing = { ok: true, missing: true };

function preparedResolve(
  projection: SessionRowProjection,
  p: SessionsResolveParams,
  client: Parameters<typeof withPreparedSessionResolve>[0]["client"] = null,
) {
  return withPreparedSessionResolve({ client, projection, p }, (result) => result);
}

describe("prepared resident resolution", () => {
  const scope = { agentId: "main", sessionKey: "agent:main:target" };
  const entry = { sessionId: "target-id", updatedAt: 1, label: "original" };
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {} } },
  };
  const selectors: SessionsResolveParams[] = [
    { key: scope.sessionKey, agentId: "main" },
    { sessionId: entry.sessionId, agentId: "main" },
    { sessionId: entry.sessionId },
    { label: entry.label, agentId: "main" },
  ];

  const projections = new Map<OpenClawConfig, Promise<SessionRowProjection>>();
  function projectionFor(config = cfg) {
    let projection = projections.get(config);
    if (!projection) {
      projection = createSessionRowProjection({ cfg: config });
      projections.set(config, projection);
    }
    return projection;
  }
  async function withProjectionState(
    options: Parameters<typeof withRawTestState>[0],
    fn: Parameters<typeof withRawTestState>[1],
  ) {
    return withRawTestState({ ...options, prepareProfileCatalog: true }, async (state) => {
      try {
        return await fn(state);
      } finally {
        for (const pending of projections.values()) {
          (await pending).dispose();
        }
        projections.clear();
      }
    });
  }
  function seed(
    sessionKey = scope.sessionKey,
    values: Parameters<typeof replaceSessionEntrySync>[1] = entry,
  ) {
    replaceSessionEntrySync({ ...scope, sessionKey }, values);
  }

  function contextFor(projection: SessionRowProjection, config = cfg) {
    return createDirectChatContext({
      getRuntimeConfig: () => config,
      ...bindSessionRowProjection({}, () => projection),
    });
  }

  function request(
    context: ReturnType<typeof contextFor>,
    params: SessionsResolveParams,
    respond: RespondFn,
    client: Parameters<
      NonNullable<(typeof sessionReadHandlers)["sessions.resolve"]>
    >[0]["client"] = null,
  ) {
    return sessionReadHandlers["sessions.resolve"]!({
      params,
      respond,
      client,
      context,
      req: { type: "req", id: "resolve", method: "sessions.resolve" },
      isWebchatConnect: () => false,
    });
  }

  const targetResult = resolved(scope.sessionKey);

  it.for(["shortId", "reference"] as const)(
    "resolves a %s link without waiting for unrelated native runtime ownership",
    async (selector, { signal }) => {
      await withProjectionState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot(cfg);
        const sessionId = "4d2e08ab-1111-4000-8000-000000000001";
        const key = `agent:main:chat:${sessionId}`;
        seed(key, { sessionId, updatedAt: 2, label: "Resolved target", visibility: "shared" });
        const sibling = { agentId: "main", sessionKey: "agent:main:resolve-unrelated" };
        const siblingEntry = {
          sessionId: "resolve-unrelated",
          updatedAt: 1,
          label: "Original sibling",
          visibility: "shared" as const,
          agentHarnessId: "resolve-owner",
          modelSelectionLocked: true,
        };
        replaceSessionEntrySync(sibling, siblingEntry);
        const previousRegistry = captureActivePluginRegistrySnapshot();
        const registry = createEmptyPluginRegistry();
        const entered = createDeferred();
        const release = createDeferred();
        let holdOwnership = false;
        registry.agentHarnesses.push({
          pluginId: "resolve-owner",
          source: "test",
          harness: {
            id: "resolve-owner",
            label: "Resolution ownership fixture",
            supports: () => ({ supported: true }),
            async resolveSessionRuntimeOwnershipAsync({ assertCurrent }) {
              if (holdOwnership) {
                entered.resolve();
                await release.promise;
              }
              assertCurrent();
              return undefined;
            },
            async runAttempt() {
              throw new Error("Resolving a session must not run a model");
            },
          },
        });
        setActivePluginRegistry(registry);
        const abort = () => release.resolve();
        signal.addEventListener("abort", abort, { once: true });
        let projection: SessionRowProjection | undefined;
        let pending: Promise<void> | undefined;
        try {
          projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
          await projection.ensureMaterialized();
          const context = contextFor(projection);
          const respond = vi.fn<RespondFn>();
          const first = await projection.withSelectionPreparation(async () => {
            holdOwnership = true;
            replaceSessionEntrySync(sibling, {
              ...siblingEntry,
              label: "Renamed sibling",
              updatedAt: 3,
            });
            pending = Promise.resolve(
              request(
                context,
                selector === "shortId" ? { shortId: "4d2e08ab" } : { reference: { key } },
                respond,
              ),
            );
            const winner = await Promise.race([
              pending.then(() => "response" as const),
              entered.promise.then(() => "native ownership" as const),
            ]);
            release.resolve();
            await pending;
            expect(respond).toHaveBeenCalledWith(
              true,
              { ok: true, key, agentId: "main", displayName: "Resolved target" },
              undefined,
            );
            return winner;
          });
          expect(first).toBe("response");
        } finally {
          release.resolve();
          await Promise.allSettled(pending ? [pending] : []);
          projection?.dispose();
          restoreActivePluginRegistrySnapshot(previousRegistry);
          signal.removeEventListener("abort", abort);
        }
      });
    },
  );

  it("reselects indexed candidates when the configured store changes during lookup", async () => {
    await withProjectionState({ scenario: "minimal" }, async (state) => {
      seed();
      const storePath = state.statePath("replacement.sqlite");
      const replacementKey = "agent:main:replacement";
      replaceSessionEntrySync({ agentId: "main", storePath, sessionKey: replacementKey }, entry);
      let currentConfig = cfg;
      const projection = await createSessionRowProjection({
        cfg,
        getConfig: () => currentConfig,
      });
      const lookup = projection.readLookup.bind(projection);
      vi.spyOn(projection, "readLookup").mockImplementationOnce(async (...args) => {
        const result = await lookup(...args);
        currentConfig = { ...cfg, session: { store: storePath } };
        sessionChanges.emit({ all: true, scope: "config" });
        return result;
      });
      try {
        await expect(preparedResolve(projection, { label: entry.label })).resolves.toEqual({
          ok: true,
          key: replacementKey,
          agentId: "main",
        });
      } finally {
        projection.dispose();
      }
    });
  });

  it("resolves indexed targets while unrelated metadata is unavailable", async () => {
    await withProjectionState({ scenario: "minimal" }, async () => {
      seed();
      const sibling = "agent:main:unavailable-metadata";
      seed(sibling, {
        sessionId: "unavailable-metadata",
        updatedAt: 2,
        skillsSnapshot: { prompt: SIBLING_PROMPT, skills: [] },
      });
      const projection = await projectionFor();
      await projection.ensureMaterialized();
      const readOwnership = runtimeOwnership.readSessionRuntimeOwnershipAsync;
      using _ = vi
        .spyOn(runtimeOwnership, "readSessionRuntimeOwnershipAsync")
        .mockImplementation((params) => {
          if (params.sessionKey === sibling) {
            throw new Error("Unrelated metadata unavailable");
          }
          return readOwnership(params);
        });
      const context = contextFor(projection);
      using parse = vi.spyOn(JSON, "parse");
      for (const params of selectors) {
        sessionChanges.emit({
          all: true,
          scope: { storePath: openOpenClawAgentDatabase(scope).path },
        });
        const respond = vi.fn();
        await request(context, params, respond);
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining(targetResult),
          undefined,
        );
      }
      expect(parse.mock.calls.some(([json]) => json.includes(SIBLING_MARKER))).toBe(false);
    });
  });

  it("resolves discovery from current metadata when an unrelated display row cannot rebuild", async () => {
    await withProjectionState({ scenario: "minimal" }, async () => {
      seed();
      const sibling = "agent:main:unrelated-display";
      seed(sibling, { sessionId: "unrelated-display", updatedAt: 2 });
      const projection = await projectionFor();
      await projection.ensureMaterialized();
      const readInputs = rowInputs.readSessionRowInputs;
      using _ = vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementation((params) => {
        if (params.key === sibling) {
          throw new Error("Unrelated display unavailable");
        }
        return readInputs(params);
      });
      sessionChanges.emit({ all: true, scope: "catalog" });
      const context = contextFor(projection);
      for (const params of [
        { sessionId: entry.sessionId },
        { label: entry.label },
        { reference: { key: scope.sessionKey } },
      ]) {
        const respond = vi.fn();
        await request(context, params, respond);
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining(targetResult),
          undefined,
        );
      }
    });
  });

  it("hydrates external changes at startup and observes tracked changes while resident", async () => {
    await withProjectionState({ label: "resolve-freshness" }, async () => {
      const client = identifiedClient(
        roleClient("view", "resolve-viewer").authenticatedUserProfile!.profileId,
      );
      const roleCfg = { ...cfg, ...rolePolicyConfig() };
      const visible = { ...entry, visibility: "shared" as const };
      seed(scope.sessionKey, visible);
      const lookup = async (p: SessionsResolveParams) =>
        preparedResolve(await projectionFor(roleCfg), p, client);
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(await lookup({ key: scope.sessionKey })).toEqual(targetResult);
        expect(await lookup({ label: entry.label })).toEqual(targetResult);
      }
      const external = new DatabaseSync(openOpenClawAgentDatabase(scope).path);
      try {
        const hidden = { ...visible, label: "external", visibility: "draft" };
        external
          .prepare("UPDATE session_nodes SET entry_json = ?, label = ? WHERE session_key = ?")
          .run(JSON.stringify(hidden), hidden.label, scope.sessionKey);
        (await projectionFor(roleCfg)).dispose();
        projections.delete(roleCfg);
        for (const selector of [
          { key: scope.sessionKey },
          { label: hidden.label },
          { label: entry.label },
        ]) {
          expect(await lookup({ ...selector, allowMissing: true })).toEqual(missing);
        }
        const tracked = { ...visible, label: "tracked" };
        replaceSessionEntrySync(scope, tracked);
        expect(await lookup({ key: scope.sessionKey })).toEqual(targetResult);
        expect(await lookup({ label: tracked.label })).toEqual(targetResult);
        expect(await lookup({ label: hidden.label, allowMissing: true })).toEqual(missing);
      } finally {
        external.close();
      }
    });
  });

  it("does not publish a discovery result after its session becomes a foreign draft", async () => {
    await withProjectionState({ label: "resolve-publication-visibility" }, async () => {
      ensureUserProfilesSchema({});
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      const client = roleClient("view", "resolve-publication-viewer");
      const owner = roleClient("write", "resolve-publication-owner");
      const roleCfg = { ...cfg, ...rolePolicyConfig() };
      const visible = {
        ...entry,
        visibility: "shared" as const,
        createdActor: {
          type: "human" as const,
          source: "profile" as const,
          id: owner.authenticatedUserProfile!.profileId,
        },
      };
      replaceSessionEntrySync(scope, visible);
      const projection = await projectionFor(roleCfg);
      await projection.ensureMaterialized();
      const context = contextFor(projection, roleCfg);
      const publications: Array<{
        visibility: string | undefined;
        response: Parameters<RespondFn>;
      }> = [];
      const publish = () =>
        request(
          context,
          { reference: { key: scope.sessionKey }, agentId: "main", allowMissing: true },
          (...response) => {
            publications.push({ visibility: loadSessionEntry(scope)?.visibility, response });
          },
          client,
        );
      await publish();
      const pending = publish();
      queueMicrotask(() => {
        replaceSessionEntrySync(scope, { ...visible, visibility: "draft" });
      });
      await pending;
      await publish();

      const found = [true, { ...targetResult, displayName: entry.label }, undefined];
      const hidden = [true, { ok: false }, undefined];
      expect(publications).toEqual([
        { visibility: "shared", response: found },
        { visibility: "shared", response: found },
        { visibility: "draft", response: hidden },
      ]);
    });
  });

  const SIBLING_MARKER = "unrelated-lookup-prompt";
  const SIBLING_PROMPT = SIBLING_MARKER.repeat(1600);
  const TARGET_PROMPT = "target-lookup-prompt".repeat(1600);
  const SIBLING_ROWS = 24;

  function seedStore() {
    const promptEntry = (sessionId: string, prompt: string, updatedAt: number) => ({
      sessionId,
      updatedAt,
      skillsSnapshot: { prompt, skills: [] },
    });
    seed(scope.sessionKey, promptEntry("target-id", TARGET_PROMPT, 2));
    for (let index = 0; index < SIBLING_ROWS; index++) {
      seed(`agent:main:sibling-${index}`, promptEntry(`sibling-${index}`, SIBLING_PROMPT, 1));
    }
  }

  it("artifacts.list resolves known and missing runs without decoding unrelated saved prompts", async () => {
    await withProjectionState({ label: "lookup-runid-projection" }, async () => {
      setRuntimeConfigSnapshot(cfg);
      seedStore();

      const projection = await projectionFor();
      const context = contextFor(projection);
      const parse = vi.spyOn(JSON, "parse");
      try {
        for (const runId of ["target-id", "absent-run-id"]) {
          const respond = vi.fn();
          await expectDefined(
            artifactsHandlers["artifacts.list"],
            "artifact list handler",
          )({
            params: { runId, agentId: "main" },
            context,
            req: { type: "req", id: runId, method: "artifacts.list" },
            client: null,
            isWebchatConnect: () => false,
            respond,
          });
          if (runId === "target-id") {
            expect(respond).toHaveBeenCalledWith(true, { artifacts: [] });
          } else {
            expect(respond).toHaveBeenCalledWith(
              false,
              undefined,
              expect.objectContaining({
                details: { type: "artifact_scope_not_found" },
              }),
            );
          }
        }
        expect(parse.mock.calls.some(([json]) => json.includes(SIBLING_MARKER))).toBe(false);
      } finally {
        parse.mockRestore();
      }
    });
  });

  it("keeps a shared-store run scoped to its logical owner", async () => {
    await withProjectionState({ label: "lookup-shared-owner" }, async (state) => {
      const storePath = state.statePath("shared.sqlite");
      const sharedConfig: OpenClawConfig = {
        agents: {
          entries: { main: {}, ops: {} },
          defaults: { sessionStore: { agentId: "ops" } },
        },
        session: { scope: "global", store: storePath },
      };
      setRuntimeConfigSnapshot(sharedConfig);
      openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      replaceSessionEntrySync(
        { agentId: "ops", storePath, sessionKey: "global" },
        { sessionId: "shared-run", updatedAt: 1 },
      );
      const projection = await projectionFor(sharedConfig);
      expect(
        projection.findBySessionId({ sessionId: "shared-run", agentId: "main", federated: true }),
      ).toMatchObject([{ agentId: "ops", key: "global", storeTarget: { agentId: "main" } }]);
      expect(resolveSessionForRun("shared-run", { agentId: "ops", projection })).toEqual(
        runOwner("global", "ops"),
      );
      expect
        .soft(resolveSessionForRun("shared-run", { agentId: "main", projection }))
        .toBeUndefined();
      expect
        .soft(resolveSessionForRun("shared-run", { projection }))
        .toEqual(runOwner("global", "ops"));
      const resolveArtifacts = await prepareArtifactSessionResolution(
        { runId: "shared-run" },
        projection,
      );
      using access = createArtifactSessionAccess({
        getRuntimeConfig: () => sharedConfig,
        client: null,
      });
      expect(await resolveArtifacts(access)).toMatchObject(runOwner("global", "ops"));
    });
  });

  it("keeps the freshest same-session-id row when prompts are not decoded", async () => {
    await withProjectionState({ label: "lookup-projection-freshness" }, async () => {
      setRuntimeConfigSnapshot(cfg);
      for (const [name, updatedAt] of [
        ["stale", 1],
        ["fresh", 99],
      ] as const) {
        seed(`agent:main:${name}`, {
          sessionId: "shared-id",
          updatedAt,
          skillsSnapshot: { prompt: SIBLING_PROMPT, skills: [] },
        });
      }

      const projection = await projectionFor();
      {
        using statements = vi.spyOn(DatabaseSync.prototype, "prepare");
        using parse = vi.spyOn(JSON, "parse");
        for (let run = 0; run < 20; run++) {
          expect(resolveSessionForRun(`orphan-${run}`, { projection })).toBeUndefined();
        }
        expect(resolveSessionForRun("shared-id", { agentId: "main", projection })).toEqual(
          runOwner("agent:main:fresh"),
        );
        expect(statements).not.toHaveBeenCalled();
        expect(parse.mock.calls.some(([json]) => json.includes(SIBLING_MARKER))).toBe(false);
      }
      seed("agent:main:stale", { sessionId: "shared-id", updatedAt: 100 });
      expect(resolveSessionForRun("shared-id", { projection })).toEqual(
        runOwner("agent:main:stale"),
      );
      expect(resolveSessionForRun("late-id", { projection })).toBeUndefined();
      seed("agent:main:late", { sessionId: "late-id", updatedAt: 1 });
      expect(resolveSessionForRun("late-id", { projection })).toEqual(runOwner("agent:main:late"));
      seed("agent:main:late", { sessionId: "rolled-id", updatedAt: 2 });
      expect(resolveSessionForRun("late-id", { projection })).toBeUndefined();
      expect(resolveSessionForRun("rolled-id", { projection })).toEqual(
        runOwner("agent:main:late"),
      );
      projection.dispose();
      expect(resolveSessionForRun("rolled-id", { projection })).toBeUndefined();
    });
  });
});

describe("resident lookup indexes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    memorySessionActorOwners.reset();
  });

  async function residentProjection(
    config: Parameters<typeof createSessionRowProjection>[0]["cfg"] = cfg,
  ) {
    const projection = await createSessionRowProjection({ cfg: config });
    return { projection, [Symbol.dispose]: () => projection.dispose() };
  }

  function observeReads() {
    const reads = observeMainThreadReads();
    return { ...reads, [Symbol.dispose]: () => reads.restore() };
  }

  function selectedCount(selections: MockInstance<SessionRowProjection["selectEntries"]>) {
    return selections.mock.results.reduce(
      (count, selection) => count + (selection.type === "return" ? selection.value.length : 0),
      0,
    );
  }

  function seed(values: Parameters<typeof replaceSessionEntrySync>[1] = entry, sessionKey = key) {
    replaceSessionEntrySync({ agentId: "main", sessionKey }, values);
  }

  function acpMeta(
    sessionKey: string,
    runtimeSessionName: string,
    identity: Pick<
      Parameters<typeof seedCanonicalAcpSessionMeta>[0],
      "sessionId" | "lifecycleRevision"
    >,
  ) {
    seedCanonicalAcpSessionMeta({
      sessionKey,
      ...identity,
      meta: {
        backend: "fixture",
        agent: "harness",
        runtimeSessionName,
        mode: "persistent",
        state: "idle",
        lastActivityAt: 1,
      },
    });
  }

  function addUnrelatedSessions() {
    for (let index = 0; index < 96; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:other-${index}` },
        { sessionId: `other-${index}`, updatedAt: index + 2, displayName: "Other session" },
      );
    }
  }

  it("resolves free ACP aliases from current resident facts without SQLite or discovery materialization", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const acpKey = "agent:harness:acp:12345678-0aaa-4000-8000-000000000009";
      const acpEntry = {
        sessionId: "free-acp-resident",
        lifecycleRevision: "resident-revision",
        updatedAt: 1,
        label: "Free ACP",
      };
      replaceSessionEntrySync({ agentId: "harness", sessionKey: acpKey }, acpEntry);
      acpMeta(acpKey.replace("agent:harness:", "agent:HARNESS:"), "free-resident", {
        lifecycleRevision: acpEntry.lifecycleRevision,
      });
      addUnrelatedSessions();
      using lifetime = new DisposableStack();
      // Keep idle preview reads outside the Gateway request lifetime.
      lifetime.defer(retainSessionListForegroundWork());
      const { projection } = lifetime.use(await residentProjection());
      await projection.ensureMaterialized();
      using reads = observeReads();
      using descriptions = vi.spyOn(projection, "describe");
      using selections = vi.spyOn(projection, "selectEntries");
      for (const p of [
        { sessionId: acpEntry.sessionId },
        { label: acpEntry.label },
        { shortId: "12345678" },
      ]) {
        selections.mockClear();
        expect(resolveSessionKeyFromResolveParams({ client: null, projection, p })).toMatchObject(
          resolved(acpKey, "harness"),
        );
        if ("sessionId" in p) {
          expect(selectedCount(selections)).toBeLessThanOrEqual(2);
        }
      }
      expect(descriptions).not.toHaveBeenCalled();
      expect(
        resolveSessionKeyFromResolveParams({ client: null, projection, p: { key: acpKey } }),
      ).toMatchObject(resolved(acpKey, "harness"));
      reads.expectIdle();
    });
  });

  const cfg = {
    agents: {
      ownership: "explicit" as const,
      entries: { main: { model: { primary: "openai/gpt-5.5" } } },
    },
  };
  const key = "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001";
  const entry = {
    sessionId: "resident-resolve",
    updatedAt: 1,
    label: "Original label",
    modelProvider: "ollama",
    model: "qwen3:7b",
  };

  it.each(["exact", "broad"] as const)(
    "resolves replaced IDs immediately after a %s committed publication",
    async (publication) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        seed();
        addUnrelatedSessions();
        using owner = await residentProjection();
        const { projection } = owner;
        const resolve = (sessionId: string) =>
          preparedResolve(projection, { sessionId, allowMissing: true });

        await projection.ensureMaterialized();
        const emit = sessionChanges.emit.bind(sessionChanges);
        using publicationSpy =
          publication === "broad"
            ? vi.spyOn(sessionChanges, "emit").mockImplementation((change, database) => {
                if ("all" in change) {
                  return emit(change, database);
                }
                const { agentId, storePath } = change;
                return emit({ all: true, scope: { agentId, storePath } }, database);
              })
            : undefined;
        await projection.withSelectionPreparation(async () => {
          runOpenClawAgentWriteTransaction(
            (database) =>
              writeSessionEntry(database, key, { ...entry, sessionId: "replacement-id" }),
            { agentId: "main" },
          );
          publicationSpy?.mockRestore();
          expect(projection.dirtyRowCount).toBeGreaterThan(0);
          expect(await resolve("replacement-id")).toEqual(resolved(key));
          expect(await resolve(entry.sessionId)).toEqual(missing);
          expect(await resolve(key)).toEqual(resolved(key));
          if (publication === "broad") {
            expect(projection.dirtyRowCount).toBeGreaterThanOrEqual(96);
          }
        });
      });
    },
  );

  it.each(["global", "unknown"] as const)(
    "keeps the advertised %s store winner when resolving IDs and filtering discovery",
    async (sentinel) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const config = {
          ...cfg,
          session: { store: state.statePath("stores", "{agentId}.sqlite") },
        };
        const configuredPath = state.statePath("stores", "main.sqlite");
        const defaultPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
        const winner = { sessionId: `configured-${sentinel}`, updatedAt: 1 };
        const shadow = { sessionId: `default-${sentinel}`, updatedAt: 2 };
        for (const [storePath, stored] of [
          [configuredPath, winner],
          [defaultPath, shadow],
        ] as const) {
          replaceSessionEntrySync({ agentId: "main", storePath, sessionKey: sentinel }, stored);
          registerOpenClawAgentDatabase({ agentId: "main", path: storePath });
        }
        using owner = await residentProjection(config);
        const { projection } = owner;
        const client = sharingPolicyClient({ user: "viewer" });
        const opts = { includeGlobal: true, includeUnknown: true };
        const resolve = (sessionId: string) =>
          preparedResolve(projection, { ...opts, sessionId, allowMissing: true }, client);

        const listed = await listProjectedSessions({ projection, client, opts });
        expect(listed.sessions).toMatchObject([
          { key: sentinel, agentId: "main", sessionId: winner.sessionId },
        ]);
        expect(projection.describe({ agentId: "main", key: sentinel })?.entry.sessionId).toBe(
          winner.sessionId,
        );
        expect(
          projection.describe({ agentId: "main", key: sentinel, storePath: defaultPath })?.entry
            .sessionId,
        ).toBe(shadow.sessionId);
        expect(await resolve(winner.sessionId)).toEqual(resolved(sentinel));
        expect(await resolve(shadow.sessionId)).toEqual(missing);

        for (const change of [{ archivedAt: 2 }, { visibility: "draft" as const }]) {
          replaceSessionEntrySync(
            { agentId: "main", storePath: configuredPath, sessionKey: sentinel },
            { ...winner, ...change },
          );
          expect(await resolve(winner.sessionId)).toEqual(missing);
          expect(await resolve(shadow.sessionId)).toEqual(missing);
          expect((await listProjectedSessions({ projection, client, opts })).sessions).toEqual([]);
          await expect(
            withPreparedSessionResolve(
              { client: null, projection, p: { key: sentinel, allowMissing: true } },
              () => projection.describe({ agentId: "main", key: sentinel })?.entry.sessionId,
            ),
          ).resolves.toBe(winner.sessionId);
        }
      });
    },
  );

  it("bounds exact resident selection without SQLite and sees committed label changes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      seed();
      addUnrelatedSessions();
      using owner = await residentProjection();
      const { projection } = owner;
      const resolve = (p: SessionsResolveParams) => preparedResolve(projection, p);

      await projection.ensureMaterialized();
      await resolve({ key });
      {
        using reads = observeReads();
        const selections = vi.spyOn(projection, "selectEntries");

        for (const p of [
          { key },
          { sessionId: entry.sessionId },
          { sessionId: entry.sessionId, agentId: "main" },
          { sessionId: key },
          { label: entry.label },
          { shortId: "12345678" },
          { reference: { key } },
          { reference: { key, slug: "other-session" } },
          { sessionId: "missing-id", allowMissing: true },
          { reference: { key: "agent:main:missing" }, allowMissing: true },
        ]) {
          selections.mockClear();
          expect(await resolve(p)).toMatchObject(p.allowMissing ? missing : resolved(key));
          if ("sessionId" in p || "reference" in p || "shortId" in p) {
            expect(selectedCount(selections)).toBeLessThanOrEqual(2);
          }
        }
        reads.expectIdle();
      }

      seed({ ...entry, label: "Updated label" });
      expect(await resolve({ label: "Updated label" })).toEqual(resolved(key));
      expect(await resolve({ label: entry.label, allowMissing: true })).toEqual(missing);
      expect(
        await resolve({ reference: { key: "agent:main:updated-label", slug: "updated-label" } }),
      ).toMatchObject(resolved(key));
      expect(
        await resolve({
          reference: { key: "agent:main:original-label", slug: "original-label" },
          allowMissing: true,
        }),
      ).toEqual(missing);
    });
  });

  it("searches stored and selected model identities from retained row facts without SQLite", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      seed();
      using owner = await residentProjection();
      const { projection } = owner;

      await projection.ensureMaterialized();
      using reads = observeReads();

      for (const search of ["Original label", "ollama/qwen3", "openai/gpt-5.5", "direct"]) {
        const opts = { search };
        expect(
          filterAndSortSessionEntries({
            ...prepareSessionRowSelection(projection, opts),
            opts,
            now: Date.now(),
          }).map(([selected]) => selected),
        ).toEqual([key]);
      }
      reads.expectIdle();
    });
  });

  it("keeps repeated-title archives cold when a literal reference resolves", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const literalKey = "agent:main:release";
      seed({ ...entry, label: "Release" }, literalKey);
      const archives = Array.from(
        { length: 8 },
        (_, index) =>
          `agent:main:dashboard:abcd1234-${index.toString(16).padStart(4, "0")}-4000-8000-000000000001`,
      );
      for (const [index, archivedKey] of archives.entries()) {
        seed(
          { ...entry, sessionId: `archive-${index}`, label: "Release", archivedAt: 1 },
          archivedKey,
        );
      }
      using owner = await residentProjection();
      const { projection } = owner;
      await projection.ensureMaterialized();
      const materialized = projection.materializedCount;
      expect(
        await preparedResolve(projection, {
          reference: { key: literalKey, slug: "release" },
        }),
      ).toMatchObject(resolved(literalKey));
      expect(projection.materializedCount - materialized).toBeLessThanOrEqual(1);
      for (const archivedKey of archives) {
        expect(
          projection.capture({ agentId: "main", key: archivedKey })?.materialized,
        ).toBeUndefined();
      }
    });
  });

  it("resolves authorized exact incognito keys without admitting them to discovery or resident rows", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const incognitoKey = "agent:main:dashboard:incognito-12345678-0aaa-4000-8000-000000000002";
      await replaceSessionEntry(
        { agentId: "main", sessionKey: incognitoKey },
        { sessionId: "private-resolve", updatedAt: 1, incognito: true, label: "Private" },
      );
      using owner = await residentProjection();
      const { projection } = owner;
      const client = sharingPolicyClient({ scopes: ["operator.admin"] });
      const resolve = (p: SessionsResolveParams) => preparedResolve(projection, p, client);

      expect(await resolve({ key: incognitoKey })).toEqual(resolved(incognitoKey));
      for (const selector of [
        { sessionId: "private-resolve" },
        { label: "Private" },
        { reference: { key: incognitoKey } },
      ]) {
        expect(await resolve({ ...selector, allowMissing: true })).toEqual(missing);
      }
      expect(
        resolveSessionKeyFromResolveParams({
          client: sharingPolicyClient({ user: "viewer" }),
          projection,
          p: { key: incognitoKey, allowMissing: true },
        }),
      ).toEqual(missing);
      expect(projection.selectEntries().length).toBe(0);
    });
  });

  it("prepares a cold exact resolution and refuses consumption after its projection owner changes", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const archivedKey = "agent:harness:acp:44444444-1111-4111-8111-111111111111";
      replaceSessionEntrySync(
        { agentId: "harness", sessionKey: archivedKey },
        { sessionId: "archived-resolve", updatedAt: 1, archivedAt: 1 },
      );
      acpMeta(archivedKey, "archived-runtime", { sessionId: "archived-resolve" });
      using owner = await residentProjection({});
      const { projection } = owner;
      const consume = vi.fn((result) => result);
      const read = (p: SessionsResolveParams, isCurrent?: () => boolean) =>
        withPreparedSessionResolve({ projection, client: null, p, isCurrent }, consume);

      expect(projection.describe({ agentId: "harness", key: archivedKey })).toBeUndefined();
      {
        using reads = observeReads();

        await expect(read({ shortId: "44444444" })).resolves.toMatchObject(
          resolved(archivedKey, "harness"),
        );
        await expect(read({ key: archivedKey })).resolves.toMatchObject(
          resolved(archivedKey, "harness"),
        );
        reads.expectIdle();
      }

      consume.mockClear();
      await expect(read({ key: archivedKey }, () => false)).rejects.toThrow(
        "Session projection changed",
      );
      expect(consume).not.toHaveBeenCalled();
    });
  });
});
