import { existsSync } from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { recordAgentDatabaseAdmissions } from "../state/agent-database-admission.js";
import {
  listAgentProvenance,
  readAgentProvenanceForDisplay,
  recordAgentProvenance,
} from "../state/agent-provenance.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { agentsListCommand } from "./agents.commands.list.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

let config: OpenClawConfig;
vi.mock("./config-validation.js", () => ({ requireValidConfig: async () => config }));
vi.mock("./agents.providers.js", () => ({
  buildProviderStatusIndex: async () => new Map(),
  buildProviderSummaryMetadataIndex: () => new Map(),
  listProvidersForAgent: () => [],
  summarizeBindings: () => [],
}));

const runtime = {
  ...createTestRuntime(),
  writeStdout: vi.fn<(value: string) => void>(),
  writeJson: vi.fn<(value: unknown) => void>(),
};

let state: Parameters<Parameters<typeof withOpenClawTestState>[1]>[0];
let sql: ReturnType<typeof observeMainThreadSql> | undefined;
let restore: (() => void) | undefined;
it.aroundEach(async (runTest) => {
  await withOpenClawTestState(
    { layout: "state-only", label: "provenance-cli" },
    async (fixture) => {
      state = fixture;
      recordAgentDatabaseAdmissions([], { env: state.env });
      vi.clearAllMocks();
      try {
        await runTest();
        await closeOpenClawStateDatabaseAsync();
        sql?.expectIdle();
      } finally {
        restore?.();
        sql?.restore();
        sql = undefined;
        restore = undefined;
        await closeOpenClawStateDatabaseAsync();
      }
    },
  );
});

function observe(parentSql = false) {
  const commands: string[] = [];
  restore = onInternalDiagnosticEvent(
    (event) => {
      if (
        event.type === "worker.request" &&
        event.phase === "queued" &&
        event.requestClass === "agentProvenance"
      ) {
        commands.push(event.kind);
      }
    },
    { include: ["worker.request"] },
  );
  if (parentSql) {
    requireNodeSqlite();
    sql = observeMainThreadSql({ includeClose: true });
    sql.calibrate();
  }
  return commands;
}

function configureRoster(ids: string[]) {
  config = {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(ids.map((id) => [id, { workspace: path.join(state.root, id) }])),
    },
  };
}

it("keeps an empty JSON roster free of provenance storage", async () => {
  configureRoster([]);
  const commands = observe();
  await agentsListCommand({ json: true }, runtime);
  expect(runtime.writeJson.mock.calls[0]?.[0]).toEqual([]);
  expect(commands).toEqual([]);
  expect(existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);
});

it("reads absent provenance without creating state or parent SQL", async () => {
  const databasePath = resolveOpenClawStateSqlitePath(state.env);
  expect(existsSync(databasePath)).toBe(false);
  observe(true);
  const options = { env: { ...state.env }, path: databasePath };
  const ids = ["main"];
  const reading = readAgentProvenanceForDisplay(ids, options);
  ids.push("later");
  const laterPath = path.join(state.stateDir, "later.sqlite");
  options.path = laterPath;
  options.env.OPENCLAW_STATE_DIR = path.join(state.stateDir, "later");
  expect(await reading).toEqual([]);
  expect(existsSync(databasePath)).toBe(false);
  expect(existsSync(laterPath)).toBe(false);
});

it("serves JSON and tree output from worker provenance through reopen", async () => {
  configureRoster(["main", "child", "legacy"]);
  const at = (nowMs: number) => ({ env: state.env, nowMs });
  await recordAgentProvenance("Main", { createdVia: "operator" }, at(10));
  await recordAgentProvenance("Child", { createdVia: "agent", creatorAgentId: "Main" }, at(20));
  await recordAgentProvenance("retired", { createdVia: "claw" }, at(30));
  await closeOpenClawStateDatabaseAsync();
  const commands = observe(true);
  await agentsListCommand({ json: true }, runtime);
  const output = runtime.writeJson.mock.calls[0]?.[0];
  expect(output).toMatchObject([
    { id: "main", createdVia: "operator", createdAt: 10 },
    { id: "child", createdVia: "agent", creatorAgentId: "main", createdAt: 20 },
    { id: "legacy" },
  ]);
  expect(output).not.toHaveProperty("2.createdVia");
  await waitForDiagnosticEventsDrained();
  expect(commands).toEqual(["stateRead"]);
  await agentsListCommand({ tree: true }, runtime);
  expect(runtime.log).toHaveBeenCalledWith("Agents:\n- main\n  - child\n- legacy");
  await closeOpenClawStateDatabaseAsync();
  const storedIds = (await listAgentProvenance({ env: state.env })).map((row) => row.agentId);
  expect(storedIds).toEqual(["child", "main", "retired"]);
});

it("enriches growing rosters with bounded requests in configured order", async () => {
  const ids = Array.from({ length: 300 }, (_, index) => `worker-${299 - index}`);
  configureRoster(ids);
  for (const [index, id] of ids.entries()) {
    await recordAgentProvenance(id, { createdVia: "operator" }, { env: state.env, nowMs: index });
  }
  await closeOpenClawStateDatabaseAsync();
  const commands = observe();
  await agentsListCommand({ json: true }, runtime);
  expect(runtime.writeJson.mock.calls[0]?.[0]).toMatchObject(
    ids.map((id, createdAt) => ({ id, createdVia: "operator", createdAt })),
  );
  await waitForDiagnosticEventsDrained();
  expect(commands).toEqual(["stateRead", "stateRead"]);
});
