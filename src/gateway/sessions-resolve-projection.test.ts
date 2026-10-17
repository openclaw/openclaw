import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { SessionsResolveParams } from "../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as runtimeOwnership from "../agents/harness/session-runtime-ownership.js";
import { saveSubagentRegistryToSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../agents/subagents/registry/subagent-registry-state.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { loadSessionEntry, replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { seedCanonicalSessionValidation } from "../config/sessions/session-canonical-validation.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState as withRawTestState } from "../test-utils/openclaw-test-state.js";
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
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";
import * as rowInputs from "./session-utils-row.js";
import { resolveGatewaySessionStoreTargetWithStoreAsync } from "./session-utils-store-lookup.js";
import {
  resolveSessionKeyFromResolveParams,
  withPreparedSessionResolve,
} from "./sessions-resolve.js";

const scope = { agentId: "main", sessionKey: "agent:main:target" };
const entry = { sessionId: "target-id", updatedAt: 1, label: "original" };
const cfg: OpenClawConfig = { agents: { ownership: "explicit", entries: { main: {} } } };
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
async function withOpenClawTestState(
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
async function resolve(p: SessionsResolveParams) {
  return resolveSessionKeyFromResolveParams({ client: null, p, projection: await projectionFor() });
}

function requestResolve(
  projection: SessionRowProjection,
  params: SessionsResolveParams,
  respond: RespondFn,
  config = cfg,
  client: Parameters<
    NonNullable<(typeof sessionReadHandlers)["sessions.resolve"]>
  >[0]["client"] = null,
) {
  return expectDefined(
    sessionReadHandlers["sessions.resolve"],
    "resolve handler",
  )({
    params,
    context: createDirectChatContext({
      getRuntimeConfig: () => config,
      ...bindSessionRowProjection({}, () => projection),
    }),
    req: { type: "req", id: "resolve", method: "sessions.resolve" },
    client,
    isWebchatConnect: () => false,
    respond,
  });
}

function seed(values: SessionEntry = entry, sessionKey = scope.sessionKey) {
  replaceSessionEntrySync({ ...scope, sessionKey }, values);
}

function observePromptReads(marker = SIBLING_MARKER) {
  const parse = vi.spyOn(JSON, "parse");
  return {
    [Symbol.dispose]: () => parse.mockRestore(),
    expectIdle: () =>
      expect(
        parse.mock.calls.filter(([json]) => typeof json === "string" && json.includes(marker)),
      ).toHaveLength(0),
  };
}

const resolved = { ok: true, key: scope.sessionKey, agentId: "main" };
const missing = { ok: true, missing: true };

describe("session resolution metadata", () => {
  it.for(["shortId", "reference"] as const)(
    "resolves a %s link without waiting for unrelated native runtime ownership",
    async (selector, { signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot(cfg);
        const sessionId = "4d2e08ab-1111-4000-8000-000000000001";
        const key = `agent:main:chat:${sessionId}`;
        seed({ sessionId, updatedAt: 2, label: "Resolved target", visibility: "shared" }, key);
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
          const currentProjection = await createSessionRowProjection({ cfg, modelCatalog: [] });
          projection = currentProjection;
          await currentProjection.ensureMaterialized();
          const respond = vi.fn<RespondFn>();
          const first = await currentProjection.withSelectionPreparation(async () => {
            holdOwnership = true;
            replaceSessionEntrySync(sibling, {
              ...siblingEntry,
              label: "Renamed sibling",
              updatedAt: 3,
            });
            pending = Promise.resolve(
              requestResolve(
                currentProjection,
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
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
        await expect(
          withPreparedSessionResolve(
            { client: null, projection, p: { label: entry.label } },
            (result) => result,
          ),
        ).resolves.toEqual({ ok: true, key: replacementKey, agentId: "main" });
      } finally {
        projection.dispose();
      }
    });
  });

  it.each(["ownership", "display"] as const)(
    "resolves indexed targets when unrelated %s metadata is unavailable",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        seed();
        const sibling = "agent:main:unavailable-metadata";
        seed({ sessionId: "unavailable-metadata", updatedAt: 2 }, sibling);
        const projection = await projectionFor();
        await projection.ensureMaterialized();
        const readOwnership = runtimeOwnership.readSessionRuntimeOwnershipAsync;
        const readInputs = rowInputs.readSessionRowInputs;
        using _ =
          kind === "ownership"
            ? vi
                .spyOn(runtimeOwnership, "readSessionRuntimeOwnershipAsync")
                .mockImplementation((params) => {
                  if (params.sessionKey === sibling) {
                    throw new Error("Unrelated metadata unavailable");
                  }
                  return readOwnership(params);
                })
            : vi.spyOn(rowInputs, "readSessionRowInputs").mockImplementation((params) => {
                if (params.key === sibling) {
                  throw new Error("Unrelated display unavailable");
                }
                return readInputs(params);
              });
        const requests =
          kind === "ownership"
            ? selectors
            : [
                { sessionId: entry.sessionId },
                { label: entry.label },
                { reference: { key: scope.sessionKey } },
              ];
        for (const params of requests) {
          sessionChanges.emit({
            all: true,
            scope:
              kind === "ownership"
                ? { storePath: openOpenClawAgentDatabase(scope).path }
                : "catalog",
          });
          const respond = vi.fn();
          await requestResolve(projection, params, respond);
          expect(respond).toHaveBeenCalledWith(true, expect.objectContaining(resolved), undefined);
        }
      });
    },
  );

  it("resolves parent-scoped key requests without hydrating retained subagent tasks", async () => {
    await withOpenClawTestState(
      { env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        const now = Date.now();
        const parent = "agent:main:main";
        const key = "agent:main:subagent:12345678-0aaa-4000-8000-000000000001";
        const selected = { ...entry, updatedAt: now, spawnedBy: parent };
        seed(selected, key);
        const rows = [key, "agent:main:subagent:retained"].map((childSessionKey, index) => ({
          runId: `resolve-run-${index}`,
          childSessionKey,
          requesterSessionKey: parent,
          requesterDisplayKey: "main",
          task: `retained-resolve-task:${"x".repeat(16_384)}`,
          cleanup: "keep" as const,
          createdAt: now - 100,
          execution: { status: "terminal" as const, startedAt: now - 100, endedAt: now - 50 },
          completion: { required: false },
          delivery: { status: "not_required" as const },
        }));
        saveSubagentRegistryToSqlite(new Map(rows.map((row) => [row.runId, row])));
        clearSubagentRunsReadCacheForTest();
        const projection = await projectionFor();
        const respond = vi.fn();
        using reads = observePromptReads("retained-resolve-task:");
        try {
          await requestResolve(projection, { key, spawnedBy: parent, agentId: "main" }, respond);
          expect(respond).toHaveBeenCalledWith(
            true,
            expect.objectContaining({ ok: true, key, agentId: "main" }),
            undefined,
          );
          reads.expectIdle();
        } finally {
          clearSubagentRunsReadCacheForTest();
        }
      },
    );
  });

  it.each(selectors)("resolves %j without decoding unrelated saved prompts", async (p) => {
    await withOpenClawTestState({ label: "resolve-prompts" }, async () => {
      seed();
      for (let index = 0; index < 3; index++) {
        seed(
          {
            sessionId: `sibling-${index}`,
            updatedAt: 1,
            skillsSnapshot: { prompt: "unrelated-resolve-prompt".repeat(1024), skills: [] },
          },
          `agent:main:sibling-${index}`,
        );
      }
      await projectionFor();
      using reads = observePromptReads("unrelated-resolve-prompt");

      expect(await resolve(p)).toEqual(resolved);
      reads.expectIdle();
    });
  });

  it("hydrates external changes at startup and observes tracked changes while resident", async () => {
    await withOpenClawTestState({ label: "resolve-freshness" }, async () => {
      const client = identifiedClient(
        roleClient("view", "resolve-viewer").authenticatedUserProfile!.profileId,
      );
      const roleCfg = { ...cfg, ...rolePolicyConfig() };
      const visible = { ...entry, visibility: "shared" as const };
      seed(visible);
      const lookup = async (p: SessionsResolveParams) =>
        withPreparedSessionResolve(
          { client, p, projection: await projectionFor(roleCfg) },
          (result) => result,
        );
      for (let repeat = 0; repeat < 2; repeat++) {
        expect(await lookup({ key: scope.sessionKey })).toEqual(resolved);
        expect(await lookup({ label: entry.label })).toEqual(resolved);
      }
      const external = new DatabaseSync(openOpenClawAgentDatabase(scope).path);
      try {
        const hidden = { ...visible, label: "external", visibility: "draft" };
        external
          .prepare("UPDATE session_nodes SET entry_json = ?, label = ? WHERE session_key = ?")
          .run(JSON.stringify(hidden), hidden.label, scope.sessionKey);
        (await projectionFor(roleCfg)).dispose();
        projections.delete(roleCfg);
        expect(await lookup({ key: scope.sessionKey, allowMissing: true })).toEqual(missing);
        expect(await lookup({ label: hidden.label, allowMissing: true })).toEqual(missing);
        expect(await lookup({ label: entry.label, allowMissing: true })).toEqual(missing);
        const tracked = { ...visible, label: "tracked" };
        seed(tracked);
        expect(await lookup({ key: scope.sessionKey })).toEqual(resolved);
        expect(await lookup({ label: tracked.label })).toEqual(resolved);
        expect(await lookup({ label: hidden.label, allowMissing: true })).toEqual(missing);
      } finally {
        external.close();
      }
    });
  });

  it("does not publish a discovery result after its session becomes a foreign draft", async () => {
    await withOpenClawTestState({ label: "resolve-publication-visibility" }, async () => {
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
      seed(visible);
      const projection = await projectionFor(roleCfg);
      await projection.ensureMaterialized();
      const publications: Array<{
        visibility: string | undefined;
        response: Parameters<RespondFn>;
      }> = [];
      const request = () =>
        requestResolve(
          projection,
          { reference: { key: scope.sessionKey }, agentId: "main", allowMissing: true },
          (...response) => {
            publications.push({ visibility: loadSessionEntry(scope)?.visibility, response });
          },
          roleCfg,
          client,
        );
      await request();
      const pending = request();
      queueMicrotask(() => {
        seed({ ...visible, visibility: "draft" });
      });
      await pending;
      await request();

      const found = [true, { ...resolved, displayName: entry.label }, undefined];
      const missingResponse = [true, { ok: false }, undefined];
      expect(publications).toEqual([
        { visibility: "shared", response: found },
        { visibility: "shared", response: found },
        { visibility: "draft", response: missingResponse },
      ]);
    });
  });

  it.each(["malformed", "mismatched-window"])(
    "omits invalid warm rows and rejects cold stores with %s rows",
    async (kind) => {
      await withOpenClawTestState({ label: "resolve-corruption" }, async () => {
        const siblingKey = "agent:main:sibling";
        seed();
        seed({ sessionId: "sibling", updatedAt: 1 }, siblingKey);
        const read = async (key: string) => {
          const target = await resolveGatewaySessionStoreTargetWithStoreAsync({
            cfg,
            key,
            agentId: "main",
            projection: "list",
            clone: false,
          });
          return target.store[target.canonicalKey];
        };
        expect((await read(scope.sessionKey))?.sessionId).toBe(entry.sessionId);
        const owner = openOpenClawAgentDatabase(scope);
        const database = owner.db;
        runSqliteImmediateTransactionSync(database, () => seedCanonicalSessionValidation(owner));
        if (kind === "malformed") {
          database
            .prepare(
              "UPDATE session_nodes SET entry_json = ?, entry_valid = 0 WHERE session_key = ?",
            )
            .run("{", scope.sessionKey);
        } else {
          database
            .prepare(
              "UPDATE session_nodes SET current_session_id = ?, entry_valid = 0 WHERE session_key = ?",
            )
            .run("different", scope.sessionKey);
        }
        expect(await read(scope.sessionKey)).toBeUndefined();
        expect((await read(siblingKey))?.sessionId).toBe("sibling");
        await closeOpenClawAgentDatabasesAsync();

        closeOpenClawAgentDatabasesForTest();
        for (const key of [scope.sessionKey, siblingKey]) {
          await expect(read(key)).rejects.toThrow(
            expect.objectContaining({ code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" }),
          );
        }
      });
    },
  );
});

// Marker lives only in sibling rows the lookups must never decode. A decode of
// this text means a store-wide read carried saved prompts into JavaScript.
const SIBLING_MARKER = "unrelated-lookup-prompt";
const SIBLING_PROMPT = SIBLING_MARKER.repeat(1600);
const TARGET_PROMPT = "target-lookup-prompt".repeat(1600);
const SIBLING_ROWS = 24;

function mainRun(sessionKey: string) {
  return { sessionKey, agentId: "main" };
}

function seedStore() {
  seed({
    sessionId: "target-id",
    updatedAt: 2,
    skillsSnapshot: { prompt: TARGET_PROMPT, skills: [] },
  });
  for (let index = 0; index < SIBLING_ROWS; index++) {
    seed(
      {
        sessionId: `sibling-${index}`,
        updatedAt: 1,
        skillsSnapshot: { prompt: SIBLING_PROMPT, skills: [] },
      },
      `agent:main:sibling-${index}`,
    );
  }
}

describe("gateway session lookups", () => {
  it("artifacts.list resolves known and missing runs without decoding unrelated saved prompts", async () => {
    await withOpenClawTestState({ label: "lookup-runid-projection" }, async () => {
      setRuntimeConfigSnapshot(cfg);
      seedStore();

      const projection = await projectionFor();
      const context = bindSessionRowProjection(
        createDirectChatContext({ getRuntimeConfig: () => cfg }),
        () => projection,
      );
      using reads = observePromptReads();

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
            expect.objectContaining({ details: { type: "artifact_scope_not_found" } }),
          );
        }
      }
      reads.expectIdle();
    });
  });

  it("keeps a shared-store run scoped to its logical owner", async () => {
    await withOpenClawTestState({ label: "lookup-shared-owner" }, async (state) => {
      const storePath = state.statePath("shared.sqlite");
      const sharedConfig: OpenClawConfig = {
        agents: { entries: { main: {}, ops: {} }, defaults: { sessionStore: { agentId: "ops" } } },
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
      expect(resolveSessionForRun("shared-run", { agentId: "ops", projection })).toEqual({
        sessionKey: "global",
        agentId: "ops",
      });
      expect
        .soft(resolveSessionForRun("shared-run", { agentId: "main", projection }))
        .toBeUndefined();
      expect
        .soft(resolveSessionForRun("shared-run", { projection }))
        .toEqual({ sessionKey: "global", agentId: "ops" });
      const resolveArtifacts = await prepareArtifactSessionResolution(
        { runId: "shared-run" },
        projection,
      );
      using access = createArtifactSessionAccess({
        getRuntimeConfig: () => sharedConfig,
        client: null,
      });
      expect(await resolveArtifacts(access)).toMatchObject({
        sessionKey: "global",
        agentId: "ops",
      });
    });
  });

  it("keeps the freshest same-session-id row when prompts are not decoded", async () => {
    await withOpenClawTestState({ label: "lookup-projection-freshness" }, async () => {
      setRuntimeConfigSnapshot(cfg);
      // Same sessionId on two keys: selection depends on updatedAt surviving the
      // metadata projection, which is the field a bad projection would drop.
      const shared = {
        sessionId: "shared-id",
        skillsSnapshot: { prompt: SIBLING_PROMPT, skills: [] },
      };
      seed({ ...shared, updatedAt: 1 }, "agent:main:stale");
      seed({ ...shared, updatedAt: 99 }, "agent:main:fresh");

      const projection = await projectionFor();
      {
        using statements = vi.spyOn(DatabaseSync.prototype, "prepare");
        using reads = observePromptReads();
        for (let run = 0; run < 20; run++) {
          expect(resolveSessionForRun(`orphan-${run}`, { projection })).toBeUndefined();
        }
        const result = resolveSessionForRun("shared-id", { agentId: "main", projection });
        expect(statements).not.toHaveBeenCalled();
        expect(result).toEqual(mainRun("agent:main:fresh"));
        reads.expectIdle();
      }
      seed({ sessionId: "shared-id", updatedAt: 100 }, "agent:main:stale");
      expect(resolveSessionForRun("shared-id", { projection })).toEqual(
        mainRun("agent:main:stale"),
      );
      expect(resolveSessionForRun("late-id", { projection })).toBeUndefined();
      seed({ sessionId: "late-id", updatedAt: 1 }, "agent:main:late");
      expect(resolveSessionForRun("late-id", { projection })).toEqual(mainRun("agent:main:late"));
      seed({ sessionId: "rolled-id", updatedAt: 2 }, "agent:main:late");
      expect(resolveSessionForRun("late-id", { projection })).toBeUndefined();
      expect(resolveSessionForRun("rolled-id", { projection })).toEqual(mainRun("agent:main:late"));
      projection.dispose();
      expect(resolveSessionForRun("rolled-id", { projection })).toBeUndefined();
    });
  });
});
