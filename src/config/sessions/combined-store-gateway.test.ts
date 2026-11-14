import fsSync, { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { retainSessionListForegroundWork } from "../../gateway/session-projection-work.js";
import {
  clearStoredSessionRowTranscriptForTest,
  observeSessionRowBackfill,
} from "../../gateway/session-row-backfill.test-support.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../../gateway/session-row-projection.js";
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
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  applyGatewaySessionStoreAdmission as applyAdmission,
  type ResolvedGatewaySessionStoreTargets,
} from "./combined-store-gateway.js";
import { loadCombinedSessionStoreForGatewayCore as loadCombinedStore } from "./combined-store-gateway.native.js";
import { storeTargetKey } from "./combined-store-paths.js";
import {
  listSessionEntriesReadOnly,
  deleteSessionEntryLifecycle,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";
import { sessionTests } from "./session-entry-fixture.test-support.js";
import type { SessionEntry } from "./types.js";

const it = sessionTests({});
const test = sessionTests();

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

it("admits repeated default-layout fleet reads without stat or realpath calls", async ({
  state,
}) => {
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
    using stat = vi.spyOn(fsSync, "statSync");
    using realpath = vi.spyOn(realpathSync, "native");
    for (let read = 0; read < 5; read++) {
      expect(applyAdmission(cfg, options, targets)).toBe(targets);
    }
    expect(stat).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  });
});

it.runIf(process.platform !== "win32")(
  "refreshes admission aliases and configured paths between reads",
  async ({ state }) => {
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
  },
);

it.runIf(process.platform !== "win32").for([
  { layout: "shared", phase: "stat", code: "EACCES" },
  { layout: "shared", phase: "identity", code: "ELOOP" },
  { layout: "templated", phase: "stat", code: "EACCES" },
  { layout: "templated", phase: "identity", code: "ELOOP" },
])(
  "isolates $code sibling $phase failures for $layout aliases but propagates requested-target failures",
  async ({ layout, phase, code }, { state }) => {
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
    const targets = admissionTargets(aliases.map((storePath) => ({ agentId: "main", storePath })));
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
      const stat = fsSync.statSync;
      const native = realpathSync.native;
      using _ =
        phase === "stat"
          ? vi.spyOn(fsSync, "statSync").mockImplementation((...args) => {
              if (args[0] === failingPath) {
                throw error;
              }
              return stat(...args);
            })
          : vi.spyOn(realpathSync, "native").mockImplementation((...args) => {
              if (args[0] === failingPath) {
                throw error;
              }
              return native(...args);
            });
      const options = admissionOptions(state.env);
      expect(applyAdmission(cfg, options, targets)).toBe(targets);
      expect(readAgentDatabaseAdmissionRefusal("broken", { env: state.env })).toBeDefined();
      failingPath = aliases[0]!;
      expect(() => applyAdmission(cfg, options, targets)).toThrow(error);
    });
  },
);

it("lists admitted sessions across cached targets while preserving a refused database", async ({
  state,
}) => {
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

it.for(["ops", "main"])(
  "rechecks %s admission after reading a shared store through a different logical owner",
  async (refusedAgentId, { state }) => {
    const storePath = state.statePath("ops.sqlite");
    openOpenClawAgentDatabase({ agentId: "main", path: storePath });
    seed({ agentId: "ops", storePath, sessionKey: "agent:ops:main" }, "ops-session");
    const cfg: OpenClawConfig = {
      agents: { entries: { ops: {} } },
      session: { store: state.statePath("{agentId}.sqlite") },
    };
    const opts = { agentId: "ops", projection: "list" as const };
    expectOwner(loadCombinedStore(cfg, opts), "agent:ops:main", "ops-session", "ops");
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
            const rows = listSessionEntriesReadOnly({ ...target, projection });
            recordAgentDatabaseAdmissions([refusal], { source: "startup", env: state.env });
            return rows;
          },
        }),
      ).toThrow(expect.objectContaining({ name: "AgentDatabaseAdmissionError", refusal }));
    } finally {
      recordAgentDatabaseAdmissions([], { source: "startup", env: state.env });
    }
  },
);

it("projects shared rows under their logical owner while retaining the physical database owner", async ({
  state,
}) => {
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
    for (const configuredAgentsOnly of [false, true]) {
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
      const globalRow = listed.sessions.find((row) => row.kind === "global")!;
      expect(globalRow).toMatchObject({
        agentId: "ops",
        model: "gpt-5.5",
        sessionId: "session-global",
        derivedTitle: title,
        lastMessagePreview: preview,
      });
      expect(listed.sessions.find((row) => row.kind === "unknown")).toMatchObject({
        agentId: "ops",
        model: "gpt-5.5",
      });
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

it.for([false, true])(
  "keeps fixed-store owners separate (symlink=%s)",
  async (alias, { state, skip }) => {
    if (alias && process.platform === "win32") {
      skip();
    }
    const storePath = state.statePath("shared.json");
    const cfg = config(["main", "ops", "worker"], { store: storePath });
    if (alias) {
      const sqlitePath = state.statePath("shared.sqlite");
      openOpenClawAgentDatabase({ agentId: "main", path: sqlitePath });
      await fs.symlink(sqlitePath, storePath);
    }
    for (const agentId of alias ? ["main"] : ["main", "ops"]) {
      seed(
        { agentId, defaultAgentId: "main", sessionKey: "global", storePath },
        `global-${agentId}`,
      );
      const combined = loadCombinedStore(cfg, { agentId });
      expectOwner(combined, "global", `global-${agentId}`, agentId);
    }
    if (alias) {
      seed(
        { agentId: "worker", defaultAgentId: "main", sessionKey: "unknown", storePath },
        "worker",
      );
      for (const configuredAgentsOnly of [false, true, true]) {
        const combined = loadCombinedStore(cfg, { configuredAgentsOnly });
        expectOwner(combined, "global", "global-main", "main");
        expectOwner(combined, "unknown", "worker", "worker");
      }
      expectOwner(loadCombinedStore(cfg, { agentId: "worker" }), "unknown", "worker", "worker");
      expect(loadCombinedStore(cfg, { agentId: "ops" }).store).toEqual({});
      return;
    }
    const registeredPath = state.statePath("separate.sqlite");
    seed({ agentId: "main", sessionKey: "unknown", storePath: registeredPath }, "separate-main");
    const combined = loadCombinedStore(cfg, { configuredAgentsOnly: true });
    expect(combined.store.unknown?.sessionId).toBe("separate-main");
    expect(combined.targetsBySessionKey.get("unknown")).toMatchObject({
      agentId: "main",
      storeTarget: { agentId: "main", storePath: registeredPath },
    });
  },
);

it.for([
  ["physical sentinel", "global", "qwen3:14b", "inherited"],
  ["missing physical parent", "global", "llama3.1:8b", null],
  ["missing qualified parent", "agent:main:dashboard:missing", "llama3.1:8b", null],
] as const)(
  "keeps %s model facts bound to stored lineage",
  async ([name, parent, model, source], { state: _state }) => {
    const cfg = config(["main", "work"], { scope: "global", mainKey: "home" }, "main", {
      systemAgent: { agentId: "main" },
      model: { primary: "ollama/llama3.1:8b" },
    });
    const write = storeSeed();
    write("main", "global", "other-owner", selectedModelFields("qwen3:8b"));
    if (name !== "missing physical parent") {
      write("work", "global", "parent", selectedModelFields("qwen3:14b"));
    }
    const key = "agent:work:dashboard:child";
    write("work", key, "child", { updatedAt: 2, parentSessionKey: parent });
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
        const searched = await list({ ...opts, search: model });
        expect(searched.sessions.some((row) => row.key === key)).toBe(true);
      }
    });
  },
);

test("keeps missing per-sender lineage literal while its model falls back to the alias", async ({
  state,
}) => {
  const cfg = config(["alpha", "main"], { scope: "per-sender", mainKey: "work" }, "alpha", {
    model: { primary: "ollama/llama3.1:8b" },
  });
  await state.writeConfig(cfg);
  state.applyEnv();
  const alias = "agent:main:work";
  const key = "agent:alpha:dashboard:child";
  const writeParent = (sessionKey: string, model: string) =>
    seed({ agentId: "main", sessionKey }, sessionKey, selectedModelFields(model));
  seed({ agentId: "alpha", sessionKey: key }, "child", { updatedAt: 2, ...lineage(mainSession) });
  registerAgentRunContext("combined-parent-live", {
    agentId: "alpha",
    sessionKey: key,
    sessionId: "child",
    projectSessionActive: true,
  });
  writeParent(alias, "qwen3:8b");
  writeParent(mainSession, "qwen3:32b");
  const release = retainSessionListForegroundWork();
  try {
    await withResidentRows(cfg, async (projection, list) => {
      const check = async (model: string) => {
        for (const opts of [{}, { agentId: "alpha" }]) {
          const result = await list(opts);
          expect(result.sessions.find((row) => row.key === key)).toMatchObject({
            ...lineage(mainSession),
            model,
            modelOverrideSource: "inherited",
          });
        }
        const filtered = await list({ spawnedBy: mainSession });
        expect(filtered.sessions.map((row) => row.key)).toContain(key);
        expect(
          projection.snapshot({ agentId: "main", key: alias }).row?.childSessions ?? [],
        ).not.toContain(key);
      };
      await check("qwen3:32b");
      expect(
        projection.snapshot({ agentId: "main", key: mainSession }).row?.childSessions,
      ).toContain(key);
      await deleteSessionEntryLifecycle({
        agentId: "main",
        storePath: projection.capture({ agentId: "main", key: mainSession })!.storeTarget.storePath,
        archiveTranscript: false,
        target: { canonicalKey: mainSession, storeKeys: [mainSession] },
      });
      await check("qwen3:8b");
    });
  } finally {
    clearAgentRunContext("combined-parent-live");
    release();
  }
});

test.for([false, true])(
  "retains scoped removed-default alias selection (present=%s)",
  async (present, { state }) => {
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
  },
);

it.for([false, true])(
  "preserves qualified retired-owner keys in a shared store (alias=%s)",
  async (alias, { state, skip }) => {
    if (alias && process.platform === "win32") {
      skip();
    }
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
  },
);

it.for(["main", "unknown", "global"])(
  "keeps qualified lineage separate from physical sentinels (mainKey=%s)",
  async (mainKey, { state }) => {
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
  },
);

it("filters retired stores by canonical lineage owners without selecting an implicit agent", async ({
  state,
}) => {
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

it("omits retained prompt payloads unless a caller opts into the full projection", async ({
  state: _state,
}) => {
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
