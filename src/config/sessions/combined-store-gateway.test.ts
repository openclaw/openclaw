import fsSync, { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { retainSessionListForegroundWork } from "../../gateway/session-projection-work.js";
import {
  clearStoredSessionRowTranscriptForTest,
  observeSessionRowBackfill,
} from "../../gateway/session-row-backfill.test-support.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../../gateway/session-row-projection.js";
import { resolveSessionStoreKey } from "../../gateway/session-store-key.js";
import { listProjectedSessions } from "../../gateway/session-utils-list.js";
import { clearAgentRunContext, registerAgentRunContext } from "../../infra/agent-run-registry.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import {
  createAgentDatabaseInspectionRefusal,
  inspectAgentDatabaseAdmission,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../../state/agent-database-startup.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../../state/openclaw-agent-db-contract.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "../../state/openclaw-database-preflight.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  applyGatewaySessionStoreAdmission as applyAdmission,
  type ResolvedGatewaySessionStoreTargets,
} from "./combined-store-gateway.js";
import { loadCombinedSessionStoreForGatewayCore as loadCombinedStore } from "./combined-store-gateway.native.js";
import { storeTargetKey } from "./combined-store-paths.js";
import * as sessionAccessor from "./session-accessor.js";
import {
  listSessionEntriesReadOnly,
  deleteSessionEntryLifecycle,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";
import type { SessionEntry } from "./types.js";

const mainSession = "agent:main:main";
const lineage = (parentSessionKey: string) => ({ parentSessionKey, spawnedBy: parentSessionKey });
type Store = ReturnType<typeof loadCombinedStore>;
function expectOwner(store: Store, key: string, id: string, owner: string) {
  expect(store.store[key]?.sessionId).toBe(id);
  expect(store.targetsBySessionKey.get(key)?.agentId).toBe(owner);
}
const owners = (store: Store) =>
  Object.fromEntries([...store.targetsBySessionKey].map(([key, target]) => [key, target.agentId]));
function seed(
  scope: Parameters<typeof replaceSessionEntrySync>[0],
  sessionId: string,
  fields: Partial<SessionEntry> = {},
) {
  return replaceSessionEntrySync(scope, { sessionId, updatedAt: 1, ...fields });
}
const selectedModelFields = (modelOverride: string) => ({
  providerOverride: "ollama",
  modelOverride,
  modelOverrideSource: "user" as const,
  modelOverrideRouteResolution: "resolved" as const,
});

function config(
  ids: string[],
  session?: OpenClawConfig["session"],
  owner = "ops",
  defaults: NonNullable<OpenClawConfig["agents"]>["defaults"] = {},
): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(ids.map((id) => [id, {}])),
      defaults: { sessionStore: { agentId: owner }, ...defaults },
    },
    session,
  };
}
function storeSeed(storePath?: string) {
  return (
    agentId: string,
    sessionKey: string,
    sessionId: string,
    fields: Partial<SessionEntry> = {},
  ) => seed({ agentId, sessionKey, storePath }, sessionId, fields);
}
const admissionOptions = (env: NodeJS.ProcessEnv) => ({
  preserveSentinelOwners: "physical" as const,
  discovery: { env, snapshot: undefined },
});

async function withResidentRows(
  cfg: OpenClawConfig,
  run: (
    projection: SessionRowProjection,
    list: (
      opts?: Parameters<typeof listProjectedSessions>[0]["opts"],
    ) => ReturnType<typeof listProjectedSessions>,
  ) => Promise<void>,
) {
  const projection = await createSessionRowProjection({ cfg });
  try {
    await run(projection, (opts = {}) => listProjectedSessions({ projection, opts }));
  } finally {
    projection.dispose();
  }
}

function admissionTargets(
  durableTargets: ResolvedGatewaySessionStoreTargets["durableTargets"],
): ResolvedGatewaySessionStoreTargets {
  return {
    defaultAgentId: "main",
    diagnostics: [],
    durableTargets,
    incognitoTargets: [],
    physicalTargets: new Map(durableTargets.map((target) => [storeTargetKey(target), target])),
  };
}

it("admits repeated default-layout fleet reads without stat or realpath calls", async () => {
  await withOpenClawTestState({ label: "fleet-admission" }, async (state) => {
    const agentIds = Array.from({ length: 32 }, (_, index) => `fleet-${index}`);
    const cfg = freezeJsonSnapshot<OpenClawConfig>({
      agents: { entries: Object.fromEntries(agentIds.map((id) => [id, {}])) },
    });
    const targets = admissionTargets(
      agentIds.map((agentId) => ({
        agentId,
        storePath: state.statePath("agents", agentId, "agent", "openclaw-agent.sqlite"),
      })),
    );
    await withAgentDatabaseStartupAdmission(async () => {
      const options = admissionOptions(state.env);
      // The generation's first read prepares configured directories and their path set.
      expect(applyAdmission(cfg, options, targets)).toBe(targets);
      const stat = vi.spyOn(fsSync, "statSync");
      const realpath = vi.spyOn(realpathSync, "native");
      try {
        for (let read = 0; read < 5; read++) {
          expect(applyAdmission(cfg, options, targets)).toBe(targets);
        }
        expect(stat).not.toHaveBeenCalled();
        expect(realpath).not.toHaveBeenCalled();
      } finally {
        stat.mockRestore();
        realpath.mockRestore();
      }
    });
  });
});

it.runIf(process.platform !== "win32")(
  "refreshes admission aliases and configured paths between reads",
  async () => {
    await withOpenClawTestState({ label: "fleet-admission-alias" }, async (state) => {
      const configured = state.statePath("configured.sqlite");
      const replacement = state.statePath("replacement.sqlite");
      const alias = state.statePath("alias.sqlite");
      await fs.writeFile(configured, "configured");
      await fs.writeFile(replacement, "replacement");
      await fs.symlink(configured, alias);
      const cfg = freezeJsonSnapshot<OpenClawConfig>({ session: { store: configured } });
      const targets = admissionTargets([{ agentId: "main", storePath: alias }]);
      await withAgentDatabaseStartupAdmission(async () => {
        const options = admissionOptions(state.env);
        expect(applyAdmission(cfg, options, targets)).toBe(targets);
        await fs.unlink(alias);
        await fs.symlink(replacement, alias);
        expect(applyAdmission(cfg, options, targets).durableTargets).toEqual([]);
        const next = freezeJsonSnapshot<OpenClawConfig>({ session: { store: replacement } });
        expect(applyAdmission(next, options, targets)).toBe(targets);
      });
    });
  },
);

it.runIf(process.platform !== "win32").each([
  { layout: "shared", phase: "stat", code: "EACCES" },
  { layout: "shared", phase: "identity", code: "ELOOP" },
  { layout: "templated", phase: "stat", code: "EACCES" },
  { layout: "templated", phase: "identity", code: "ELOOP" },
])(
  "isolates $code sibling $phase failures for $layout aliases but propagates requested-target failures",
  async ({ layout, phase, code }) => {
    await withOpenClawTestState({ label: "admission-unreadable-sibling" }, async (state) => {
      const healthy = state.statePath("main.sqlite");
      const brokenDir = state.statePath("broken-agent");
      const broken =
        layout === "shared"
          ? path.join(brokenDir, "openclaw-agent.sqlite")
          : state.statePath("broken.sqlite");
      await fs.mkdir(brokenDir);
      await fs.writeFile(healthy, "healthy");
      await fs.writeFile(broken, "unreadable");
      const aliases = [state.statePath("alias.sqlite"), state.statePath("second-alias.sqlite")];
      await Promise.all(aliases.map((alias) => fs.symlink(healthy, alias)));
      const cfg = freezeJsonSnapshot<OpenClawConfig>({
        agents: { entries: { broken: { agentDir: brokenDir }, main: {} } },
        session: { store: layout === "shared" ? healthy : state.statePath("{agentId}.sqlite") },
      });
      const targets = admissionTargets(
        aliases.map((storePath) => ({ agentId: "main", storePath })),
      );
      const error = Object.assign(new Error("synthetic filesystem inspection failure"), { code });
      recordAgentDatabaseAdmissions(
        [
          createAgentDatabaseInspectionRefusal({
            agentId: "broken",
            paths: [broken],
            reason: error.message,
            cause: error,
          }),
        ],
        { env: state.env, source: "startup" },
      );
      await withAgentDatabaseStartupAdmission(async () => {
        let failingPath = broken;
        let failures = 0;
        const stat = fsSync.statSync;
        const native = realpathSync.native;
        const statSpy = vi.spyOn(fsSync, "statSync").mockImplementation((...args) => {
          if (phase === "stat" && args[0] === failingPath) {
            failures++;
            throw error;
          }
          return stat(...args);
        });
        const realpathSpy = vi.spyOn(realpathSync, "native").mockImplementation((...args) => {
          if (phase === "identity" && args[0] === failingPath) {
            failures++;
            throw error;
          }
          return native(...args);
        });
        const options = admissionOptions(state.env);
        try {
          expect(applyAdmission(cfg, options, targets)).toBe(targets);
          expect(failures).toBe(layout === "shared" ? 0 : 1);
          expect(readAgentDatabaseAdmissionRefusal("broken", { env: state.env })).toBeDefined();
          failingPath = aliases[0]!;
          expect(() => applyAdmission(cfg, options, targets)).toThrow(error);
        } finally {
          statSpy.mockRestore();
          realpathSpy.mockRestore();
        }
      });
    });
  },
);

it("lists admitted sessions across cached targets while preserving a refused database", async () => {
  await withOpenClawTestState({ label: "combined-admission" }, async (state) => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {}, cleaner: {} } } };
    const read = () => loadCombinedStore(cfg, { configuredAgentsOnly: true }).store;
    for (const agentId of ["main", "cleaner"]) {
      seed({ agentId, sessionKey: `agent:${agentId}:main` }, `${agentId}-session`);
    }
    expect(Object.keys(read())).toHaveLength(2);
    const copyPath = openOpenClawAgentDatabase({ agentId: "cleaner" }).path;
    await closeOpenClawAgentDatabasesAsync(state.root);
    closeOpenClawAgentDatabasesForTest();
    revokeSqliteDatabaseAdmissionsForPath(copyPath);
    const { DatabaseSync } = requireNodeSqlite();
    const editMetadata = (version: number, agentId: string) => {
      const database = new DatabaseSync(copyPath);
      database.exec(
        `PRAGMA user_version = ${version}; UPDATE schema_meta SET agent_id = '${agentId}', schema_version = ${version};`,
      );
      database.close();
    };
    const preflight = () =>
      assertOpenClawDatabasesReady({ config: cfg, env: state.env, operation: "gateway-startup" });
    editMetadata(16, "main");
    await preflight();
    const refusal = readAgentDatabaseAdmissionRefusal("cleaner");
    expect(refusal).toBeDefined();
    const before = await fs.readFile(copyPath);

    for (const configuredAgentsOnly of [false, true]) {
      const combined = loadCombinedStore(cfg, { configuredAgentsOnly });
      expect(Object.keys(combined.store)).toEqual([mainSession]);
      expect(combined.diagnostics?.join("\n")).toContain(refusal?.reason);
    }
    expect(() => loadCombinedStore(cfg, { agentId: "cleaner" })).toThrow(refusal?.reason);
    const scoped = loadCombinedStore(cfg, { agentId: "main" });
    expect(
      scoped.targetsBySessionKey.get(mainSession)?.readSourceEntry("agent:cleaner:main"),
    ).toBeUndefined();
    expect(scoped.diagnostics?.join("\n")).toContain(refusal?.reason);
    expect(await fs.readFile(copyPath)).toEqual(before);

    await closeOpenClawAgentDatabasesAsync(state.root);
    revokeSqliteDatabaseAdmissionsForPath(copyPath);
    editMetadata(OPENCLAW_AGENT_SCHEMA_VERSION, "cleaner");
    await preflight();
    expect(Object.keys(read())).toHaveLength(2);
  });
});

it.each(["ops", "main"])(
  "rechecks %s admission after reading a shared store through a different logical owner",
  async (refusedAgentId) => {
    await withOpenClawTestState({ label: "combined-read-admission" }, async (state) => {
      const storePath = state.statePath("ops.sqlite");
      openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      seed({ agentId: "ops", storePath, sessionKey: "agent:ops:main" }, "ops-session");
      const cfg: OpenClawConfig = {
        agents: { entries: { ops: {} } },
        session: { store: state.statePath("{agentId}.sqlite") },
      };
      const opts = { agentId: "ops", projection: "list" as const };
      const expected = loadCombinedStore(cfg, opts);
      expect(expected.durableTargets).toEqual([{ agentId: "ops", storePath }]);
      expect(expected.targetsBySessionKey.get("agent:ops:main")?.storeTarget).toEqual({
        agentId: "main",
        storePath,
      });
      const refusal = inspectAgentDatabaseAdmission({
        agentId: refusedAgentId,
        path: storePath,
        metadata: { role: "agent", agentId: "replacement-owner" },
      })!;
      try {
        expect(() =>
          loadCombinedStore(cfg, {
            ...opts,
            loadEntries: (target, projection) => {
              expect(target).toEqual({ agentId: "main", storePath });
              const rows = listSessionEntriesReadOnly({ ...target, projection });
              recordAgentDatabaseAdmissions([refusal], { source: "startup", env: state.env });
              return rows;
            },
          }),
        ).toThrow(expect.objectContaining({ name: "AgentDatabaseAdmissionError", refusal }));
      } finally {
        recordAgentDatabaseAdmissions([], { source: "startup", env: state.env });
      }
    });
  },
);

it("projects shared rows under their logical owner while retaining the physical database owner", async () => {
  await withOpenClawTestState({ label: "combined-store-owner" }, async (state) => {
    const storePath = state.statePath("shared.sqlite");
    const title = "Shared physical global title";
    const preview = "Shared physical global preview";
    const cfg = config(["main", "ops", "worker"], { scope: "global", store: storePath });
    cfg.agents!.entries!.ops = { model: { primary: "openai/gpt-5.5" } };
    setRuntimeConfigSnapshot(cfg);
    openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    for (const sessionKey of ["global", "unknown", "agent:worker:task"]) {
      seed(
        { agentId: sessionKey.startsWith("agent:") ? "worker" : "ops", sessionKey, storePath },
        `session-${sessionKey}`,
        { displayName: sessionKey === "global" ? title : undefined },
      );
    }
    await persistSessionTranscriptTurn(
      { agentId: "ops", storePath, sessionKey: "global", sessionId: "session-global" },
      {
        messages: [{ message: { role: "user", content: preview } }],
        touchSessionEntry: false,
      },
    );
    clearStoredSessionRowTranscriptForTest({
      agentId: "main",
      storePath,
      sessionKey: "global",
      sessionId: "session-global",
    });

    const releaseBackfill = retainSessionListForegroundWork();
    await withResidentRows(cfg, async (projection, list) => {
      const query = { key: "global", agentId: "ops", storePath };
      expect(
        projection.snapshot(query, { includeLastMessage: true }).row?.lastMessagePreview,
      ).toBeUndefined();
      const backfilled = observeSessionRowBackfill(["global"], projection);
      releaseBackfill();
      await backfilled;
      expect(
        projection.snapshot(query, { includeDerivedTitles: true, includeLastMessage: true }).row,
      ).toMatchObject({
        derivedTitle: title,
        lastMessagePreview: preview,
      });
      for (const configuredAgentsOnly of [false, true]) {
        const combined = loadCombinedStore(cfg, { configuredAgentsOnly });
        expect(combined.durableTargets).toEqual([{ agentId: "main", storePath }]);
        expect(
          [...combined.targetsBySessionKey.values()].map(({ storeTarget }) => storeTarget),
        ).toEqual(Array.from({ length: 3 }, () => ({ agentId: "main", storePath })));
        expect(owners(combined)).toEqual({
          global: "ops",
          unknown: "ops",
          "agent:worker:task": "worker",
        });

        const ownerPreserving = loadCombinedStore(cfg, {
          configuredAgentsOnly,
          preserveSentinelOwners: true,
        });
        const listed = await list({
          configuredAgentsOnly,
          includeGlobal: true,
          includeUnknown: true,
          includeDerivedTitles: true,
          includeLastMessage: true,
        });
        expect(listed.sessions).toHaveLength(3);
        expect(listed.sessions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              kind: "global",
              agentId: "ops",
              model: "gpt-5.5",
              sessionId: "session-global",
              derivedTitle: title,
              lastMessagePreview: preview,
            }),
            expect.objectContaining({ kind: "unknown", agentId: "ops", model: "gpt-5.5" }),
          ]),
        );
        const globalRow = listed.sessions.find((row) => row.kind === "global")!;
        expect(
          [...ownerPreserving.targetsBySessionKey.values()].find(
            (target) => target.storeKey === globalRow.key && target.agentId === globalRow.agentId,
          ),
        ).toMatchObject({
          agentId: "ops",
          storeKey: "global",
          storeTarget: { agentId: "main", storePath },
        });
      }
      for (const [agentId, keys] of [
        ["main", []],
        ["ops", ["global", "unknown"]],
        ["worker", ["agent:worker:task"]],
      ] as const) {
        const combined = loadCombinedStore(cfg, { agentId });
        expect(Object.keys(combined.store).toSorted()).toEqual([...keys].toSorted());
      }
    }).finally(releaseBackfill);
  });
});

it("keeps fixed-store ownership out of separate registered and suffixed databases", async () => {
  await withOpenClawTestState({ label: "combined-store-partitions" }, async (state) => {
    const storePath = state.statePath("shared.json");
    const cfg = config(["main", "ops"], { store: storePath });
    for (const agentId of ["main", "ops"]) {
      seed(
        { agentId, defaultAgentId: "main", sessionKey: "global", storePath },
        `global-${agentId}`,
      );
    }
    for (const agentId of ["main", "ops"]) {
      const combined = loadCombinedStore(cfg, { agentId });
      expectOwner(combined, "global", `global-${agentId}`, agentId);
    }

    const registeredPath = state.statePath("separate.sqlite");
    seed({ agentId: "main", sessionKey: "unknown", storePath: registeredPath }, "separate-main");
    const combined = loadCombinedStore(cfg, { configuredAgentsOnly: true });
    expect(combined.store.unknown?.sessionId).toBe("separate-main");
    expect(combined.targetsBySessionKey.get("unknown")).toMatchObject({
      agentId: "main",
      storeTarget: { agentId: "main", storePath: registeredPath },
    });
  });
});

it.each([
  ["physical sentinel", "global", "qwen3:14b", "inherited"],
  ["shared physical sentinel", "global", "qwen3:14b", "inherited"],
  ["literal configured-main parent", "agent:main:home", "qwen3:30b", "inherited"],
  ["literal scoped sentinel", "agent:main:global", "qwen3:32b", "inherited"],
  ["missing physical parent", "global", "llama3.1:8b", null],
  ["missing qualified parent", "agent:main:dashboard:missing", "llama3.1:8b", null],
] as const)("keeps %s model facts bound to stored lineage", async (name, parent, model, source) => {
  await withOpenClawTestState({ label: "combined-parent-model" }, async (state) => {
    const shared = name === "shared physical sentinel";
    const storePath = shared ? state.statePath("shared.sqlite") : undefined;
    const cfg = config(
      shared ? ["main", "ops", "work"] : ["main", "work"],
      { scope: "global", ...(shared ? { store: storePath } : { mainKey: "home" }) },
      shared ? "ops" : "main",
      {
        ...(!shared ? { systemAgent: { agentId: "main" } } : {}),
        model: { primary: "ollama/llama3.1:8b" },
      },
    );
    const write = storeSeed(storePath);
    if (shared) {
      openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    }
    const parents: Array<[string, string, string]> = shared
      ? [["ops", "global", "qwen3:14b"]]
      : [
          ["main", "global", "qwen3:8b"],
          ["main", "agent:main:main", "qwen3:4b"],
          ["main", "agent:main:home", "qwen3:30b"],
          ["main", "agent:main:global", "qwen3:32b"],
        ];
    if (!shared && name !== "missing physical parent") {
      parents.push(["work", "global", "qwen3:14b"]);
    }
    for (const [agentId, sessionKey, selectedModel] of parents) {
      write(agentId, sessionKey, `${agentId}-${sessionKey}`, selectedModelFields(selectedModel));
    }
    const key = "agent:work:dashboard:child";
    write("work", key, "child", { updatedAt: 2, parentSessionKey: parent });
    if (shared) {
      const combined = loadCombinedStore(cfg);
      expect(combined.targetsBySessionKey.get(key)?.storeTarget).toEqual({
        agentId: "main",
        storePath,
      });
    }
    await withResidentRows(cfg, async (_projection, list) => {
      for (const opts of [{}, { agentId: "work" }]) {
        const result = await list(opts);
        expect(result.sessions.find((row) => row.key === key)).toMatchObject({
          agentId: "work",
          modelProvider: "ollama",
          model,
          modelOverrideSource: source,
          parentSessionKey: parent,
        });
        if (shared && opts.agentId) {
          expect(result.sessions).toMatchObject([
            { agentId: "work", model, modelOverrideSource: source },
          ]);
        }
        const searched = await list({ ...opts, search: model });
        expect(searched.sessions.some((row) => row.key === key)).toBe(true);
      }
    });
  });
});

it.each(["global", "per-sender"] as const)(
  "selects a later stored parent before its current alias in %s views",
  async (scope) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = config(["alpha", "main"], { scope, mainKey: "work" }, "alpha", {
        model: { primary: "ollama/llama3.1:8b" },
      });
      await state.writeConfig(cfg);
      state.applyEnv();
      const parent = mainSession;
      const alias = scope === "global" ? "global" : "agent:main:work";
      const key = "agent:alpha:dashboard:child";
      const writeParent = (sessionKey: string, model: string) =>
        seed({ agentId: "main", sessionKey }, sessionKey, selectedModelFields(model));
      seed({ agentId: "alpha", sessionKey: key }, "child", { updatedAt: 2, ...lineage(parent) });
      registerAgentRunContext("combined-parent-live", {
        agentId: "alpha",
        sessionKey: key,
        sessionId: "child",
        projectSessionActive: true,
      });
      writeParent(alias, "qwen3:8b");
      writeParent(parent, "qwen3:32b");
      expect(resolveSessionStoreKey({ cfg, sessionKey: parent })).toBe(alias);
      const release = retainSessionListForegroundWork();
      try {
        await withResidentRows(cfg, async (projection, list) => {
          const check = async (model: string, literal: boolean) => {
            const displayParent = literal || scope !== "global" ? parent : "global";
            for (const opts of [{}, { agentId: "alpha" }]) {
              // Alpha loads first; both the full inventory and a missing-owner exact join agree.
              const combined = loadCombinedStore(cfg, opts);
              expect(combined.store[key]).toMatchObject(lineage(displayParent));
              const reads = vi.spyOn(sessionAccessor, "loadExactSessionEntryCandidates");
              try {
                const source = combined.targetsBySessionKey.get(key)!;
                expect(source.readSourceEntry(parent)?.modelOverride).toBe(model);
                const firstReads = reads.mock.calls.length;
                if (scope === "global") {
                  expect(firstReads).toBe(0);
                }
                expect(source.readSourceEntry(parent)?.modelOverride).toBe(model);
                expect(reads.mock.calls).toHaveLength(firstReads);
              } finally {
                reads.mockRestore();
              }
              const result = await list(opts);
              expect(result.sessions.find((row) => row.key === key)).toMatchObject({
                ...lineage(displayParent),
                model,
                modelOverrideSource: "inherited",
              });
            }
            const filtered = await list({ spawnedBy: displayParent });
            expect(filtered.sessions.map((row) => row.key)).toContain(key);
            const children =
              projection.snapshot({ agentId: "main", key: literal ? parent : alias }).row
                ?.childSessions ?? [];
            if (literal || scope === "global") {
              expect(children).toContain(key);
            } else {
              // Per-sender navigation keeps the missing literal address, even with model fallback.
              expect(children).not.toContain(key);
            }
            if (literal) {
              expect(
                projection.snapshot({ agentId: "main", key: alias }).row?.childSessions ?? [],
              ).not.toContain(key);
            }
          };
          await check("qwen3:32b", true);
          writeParent(alias, "qwen3:14b");
          await check("qwen3:32b", true);
          await deleteSessionEntryLifecycle({
            agentId: "main",
            storePath: projection.capture({ agentId: "main", key: parent })!.storeTarget.storePath,
            archiveTranscript: false,
            target: { canonicalKey: parent, storeKeys: [parent] },
          });
          await check("qwen3:14b", false);
          writeParent(alias, "qwen3:8b");
          await check("qwen3:8b", false);
          writeParent(parent, "qwen3:32b");
          await check("qwen3:32b", true);
        });
      } finally {
        clearAgentRunContext("combined-parent-live");
        release();
      }
    });
  },
);

it.each([false, true])(
  "retains scoped removed-default alias selection (present=%s)",
  async (present) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const cfg = config(["ops", "work"], undefined, "ops", { systemAgent: { agentId: "ops" } });
      await state.writeConfig(cfg);
      state.applyEnv();
      if (present) {
        seed({ agentId: "ops", sessionKey: "agent:ops:main" }, "replacement-owner", {
          modelOverride: "qwen3:8b",
        });
      }
      const key = "agent:work:dashboard:child";
      seed({ agentId: "work", sessionKey: key }, "child", { parentSessionKey: mainSession });
      const scoped = loadCombinedStore(cfg, { agentId: "work" });
      expect(scoped.store[key]?.parentSessionKey).toBe("agent:main:main");
      const source = scoped.targetsBySessionKey.get(key)!;
      expect(source.readSourceEntry("agent:main:main")?.sessionId).toBe(
        present ? "replacement-owner" : undefined,
      );
      const reads = vi.spyOn(sessionAccessor, "loadExactSessionEntryCandidates");
      try {
        expect(source.readSourceEntry("agent:main:main")?.sessionId).toBe(
          present ? "replacement-owner" : undefined,
        );
        expect(reads).not.toHaveBeenCalled();
      } finally {
        reads.mockRestore();
      }
    });
  },
);

it.for([false, true])(
  "preserves qualified retired-owner keys in a shared store (alias=%s)",
  async (alias, context) => {
    if (alias && process.platform === "win32") {
      context.skip();
    }
    await withOpenClawTestState({ label: "combined-store-retired-owner" }, async (state) => {
      const storePath = state.statePath("shared.sqlite");
      const cfg = config(["ops", "worker"], { store: storePath });
      const physicalPath = alias
        ? path.join(state.agentDir("main"), "openclaw-agent.sqlite")
        : storePath;
      openOpenClawAgentDatabase({ agentId: "main", path: physicalPath });
      if (alias) {
        await fs.symlink(physicalPath, storePath);
      }
      const write = storeSeed(storePath);
      write("main", mainSession, "retired-main");
      write("ops", "global", "ops-global", lineage(mainSession));

      // Repeat the configured-only load to exercise the prepared target snapshot.
      for (const configuredAgentsOnly of [false, true, true]) {
        const combined = loadCombinedStore(cfg, { configuredAgentsOnly });
        if (configuredAgentsOnly) {
          expect(combined.store[mainSession]).toBeUndefined();
          expect(combined.targetsBySessionKey.has(mainSession)).toBe(false);
        } else {
          expectOwner(combined, mainSession, "retired-main", "main");
        }
        expect(combined.targetsBySessionKey.get("global")?.agentId).toBe("ops");
        expect(combined.store.global).toMatchObject(lineage(mainSession));
      }
      expect(loadCombinedStore(cfg, { agentId: "ops" }).store).toEqual({
        global: expect.objectContaining({ sessionId: "ops-global" }),
      });
    });
  },
);

it.for(["main", "unknown", "global"])(
  "keeps qualified lineage separate from physical sentinels (mainKey=%s)",
  async (mainKey) => {
    await withOpenClawTestState({ label: "combined-store-global-lineage" }, async (state) => {
      const storePath = state.statePath("shared.sqlite");
      const cfg = config(["main", "ops", "worker"], { scope: "global", mainKey, store: storePath });
      const write = storeSeed(storePath);
      const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
      setCanonicalSqliteSessionMainKey(database, mainKey);
      const qualifiedParent = `agent:ops:${mainKey}`;
      for (const sessionKey of ["global", "unknown", qualifiedParent]) {
        write("ops", sessionKey, `parent-${sessionKey}`, { updatedAt: Date.now() });
      }
      for (const [name, parentSessionKey, parentSessionId] of [
        ["qualified", qualifiedParent, `parent-${qualifiedParent}`],
        ["global", "global", "parent-global"],
        ["unknown", "unknown", "parent-unknown"],
      ] as const) {
        write("worker", `agent:worker:subagent:${name}`, `child-${name}`, {
          updatedAt: Date.now(),
          parentSessionId,
          ...lineage(parentSessionKey),
        });
      }
      await withResidentRows(cfg, async (_projection, list) => {
        for (const [spawnedBy, children] of [
          [qualifiedParent, ["qualified"]],
          ["global", ["global"]],
          ["unknown", ["unknown"]],
        ] as const) {
          const selected = await list({ spawnedBy, configuredAgentsOnly: true });
          expect(selected.sessions.map(({ key }) => key).toSorted()).toEqual(
            children.map((name) => `agent:worker:subagent:${name}`).toSorted(),
          );
        }
      });
    });
  },
);

it("filters retired stores by canonical lineage owners without selecting an implicit agent", async () => {
  await withOpenClawTestState({ label: "combined-store-retired-lineage" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
      session: { store: state.statePath("agents", "{agentId}", "sessions", "sessions.json") },
    };
    const storePath = state.statePath("agents", "archive", "sessions", "sessions.json");
    for (const [name, parentSessionKey] of [
      ["retired", "agent:main:main"],
      ["configured", "agent:ops:main"],
    ] as const) {
      seed(
        { agentId: "archive", sessionKey: `agent:archive:${name}`, storePath },
        name,
        lineage(parentSessionKey),
      );
    }
    const unfiltered = loadCombinedStore(cfg);
    expect(unfiltered.store["agent:archive:retired"]).toMatchObject(lineage(mainSession));
    const filtered = loadCombinedStore(cfg, { configuredAgentsOnly: true });
    expect(Object.keys(filtered.store)).toEqual(["agent:archive:configured"]);
    expect(owners(filtered)).toEqual({ "agent:archive:configured": "archive" });
    expect(filtered.store["agent:archive:configured"]).toMatchObject(lineage("agent:ops:main"));
  });
});

it.skipIf(process.platform === "win32")(
  "keeps suffix owners when a legacy selector aliases the shared database",
  async () => {
    await withOpenClawTestState({ label: "combined-store-selector-alias" }, async (state) => {
      const storePath = state.statePath("shared.json");
      const sqlitePath = state.statePath("shared.sqlite");
      const cfg = config(["main", "ops", "worker"], { store: storePath });
      openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath });
      await fs.symlink(sqlitePath, storePath);
      seed({ agentId: "main", sessionKey: "global", storePath }, "main-global");
      seed(
        { agentId: "worker", defaultAgentId: "main", sessionKey: "unknown", storePath },
        "worker-unknown",
      );
      for (const configuredAgentsOnly of [false, true, true]) {
        const combined = loadCombinedStore(cfg, { configuredAgentsOnly });
        expectOwner(combined, "unknown", "worker-unknown", "worker");
        expectOwner(combined, "global", "main-global", "main");
      }
      const scoped = loadCombinedStore(cfg, { agentId: "worker" });
      expect(scoped.targetsBySessionKey.get("unknown")?.agentId).toBe("worker");
      expect(loadCombinedStore(cfg, { agentId: "ops" }).store).toEqual({});
      expect(
        loadCombinedStore(cfg, { agentId: "main" }).targetsBySessionKey.get("global")?.agentId,
      ).toBe("main");
    });
  },
);

it("omits retained prompt payloads unless a caller opts into the full projection", async () => {
  await withOpenClawTestState({ label: "combined-store-projection" }, async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:main" },
      {
        sessionId: "prompt-payload-session",
        updatedAt: 7,
        skillsSnapshot: { prompt: "skill prompt body", skills: [{ name: "example" }] },
        systemPromptReport: {
          source: "run",
          generatedAt: 7,
          systemPrompt: { chars: 17, projectContextChars: 0, nonProjectContextChars: 17 },
          injectedWorkspaceFiles: [],
          skills: { promptChars: 17, entries: [{ name: "example", blockChars: 17 }] },
          tools: { listChars: 0, schemaChars: 0, entries: [] },
        },
      },
    );

    const defaultEntry = loadCombinedStore(cfg).store["agent:main:main"];
    expect.soft(defaultEntry?.sessionId).toBe("prompt-payload-session");
    expect.soft(defaultEntry?.skillsSnapshot).toBeUndefined();
    expect.soft(defaultEntry?.systemPromptReport).toBeUndefined();

    const fullEntry = loadCombinedStore(cfg, { projection: "full" }).store["agent:main:main"];
    expect(fullEntry).toMatchObject({
      skillsSnapshot: { prompt: "skill prompt body" },
      systemPromptReport: { systemPrompt: { chars: 17 } },
    });
  });
});
