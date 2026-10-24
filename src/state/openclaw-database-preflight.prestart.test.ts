import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withDatabaseEngineSelection } from "../infra/database-engine/context.js";
import type { DatabaseEngineSelection } from "../infra/database-engine/types.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import type { StateSchemaInspection } from "./openclaw-state-schema-preflight.js";

type StateReply = { type: "stateBootstrap.inspect"; inspection: StateSchemaInspection };
const stateRead = vi.hoisted(() => vi.fn<() => Promise<StateReply>>());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, fork: vi.fn(actual.fork) };
});
vi.mock("./openclaw-state-db-readonly.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./openclaw-state-db-readonly.js")>()),
  executeExistingOpenClawStateRead: stateRead,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const stateReply = (): StateReply => ({
  type: "stateBootstrap.inspect",
  inspection: {
    schemas: { incompatible: [], indeterminate: [] },
    registeredDatabases: [],
    deletionJournal: { status: "empty" },
    inspectionErrors: [],
  },
});

function beginPreflight(agentEngine: "postgres" | "sqlite", signal?: AbortSignal) {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("preflight-prestart-") };
  const statePath = resolveOpenClawStateSqlitePath(env);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, "synthetic PostgreSQL store anchor");
  const selection: DatabaseEngineSelection = {
    effectiveEngines: {
      state: "postgres",
      agent: agentEngine,
      workboard: "sqlite",
      logbook: "sqlite",
      "team-reports": "sqlite",
      quarantine: "sqlite",
      "managed-update": "sqlite",
      "package-activation": "sqlite",
    },
    postgres: { connection: "postgresql://unused.invalid/preflight", schemaPrefix: "preflight" },
  };
  return withDatabaseEngineSelection(selection, () =>
    preflightOpenClawDatabaseSchemas(
      { env, signal, requireStartupMigrationReadiness: true },
      "runtime",
    ),
  );
}

it.each(["postgres", "sqlite"] as const)(
  "starts only the PostgreSQL agent reader before state discovery and closes it for zero targets (%s)",
  async (agentEngine) => {
    const state = createDeferred<StateReply>();
    stateRead.mockReset().mockReturnValue(state.promise);
    vi.mocked(fork).mockClear();
    const preflight = beginPreflight(agentEngine);
    try {
      expect(stateRead).toHaveBeenCalledOnce();
      expect(fork).toHaveBeenCalledTimes(agentEngine === "postgres" ? 1 : 0);
      const child = vi.mocked(fork).mock.results[0]?.value;
      const closed = vi.fn();
      child?.once("close", closed);
      state.resolve(stateReply());
      await expect(preflight).resolves.toEqual({ incompatible: [], indeterminate: [] });
      expect(fork).toHaveBeenCalledTimes(agentEngine === "postgres" ? 1 : 0);
      expect(closed).toHaveBeenCalledTimes(agentEngine === "postgres" ? 1 : 0);
    } finally {
      state.resolve(stateReply());
      await preflight.catch(() => {});
    }
  },
);

it("joins the unused PostgreSQL reader when startup aborts during state discovery", async () => {
  const state = createDeferred<StateReply>();
  stateRead.mockReset().mockReturnValue(state.promise);
  vi.mocked(fork).mockClear();
  const controller = new AbortController();
  const preflight = beginPreflight("postgres", controller.signal);
  const reason = new Error("startup stopped during state discovery");
  try {
    expect(fork).toHaveBeenCalledOnce();
    const child = vi.mocked(fork).mock.results[0]?.value;
    const closed = vi.fn();
    child.once("close", closed);
    const rejected = expect(preflight).rejects.toBe(reason);
    controller.abort(reason);
    state.reject(reason);
    await rejected;
    expect(closed).toHaveBeenCalledOnce();
  } finally {
    state.resolve(stateReply());
    await preflight.catch(() => {});
  }
});
