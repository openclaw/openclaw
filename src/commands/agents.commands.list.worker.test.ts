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
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
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

function createRuntime() {
  return {
    ...createTestRuntime(),
    writeStdout: vi.fn<(value: string) => void>(),
    writeJson: vi.fn<(value: unknown) => void>(),
  };
}

function withState(run: (state: OpenClawTestState) => Promise<void>) {
  return () =>
    withOpenClawTestState({ layout: "state-only", label: "provenance-cli" }, async (state) => {
      recordAgentDatabaseAdmissions([], { env: state.env });
      try {
        await run(state);
      } finally {
        await closeOpenClawStateDatabaseAsync();
      }
    });
}

async function observe(
  run: (runtime: ReturnType<typeof createRuntime>, commands: string[]) => Promise<void>,
  parentSql = false,
) {
  const commands: string[] = [];
  const restore = onInternalDiagnosticEvent(
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
  let sql: ReturnType<typeof observeMainThreadSql> | undefined;
  try {
    if (parentSql) {
      requireNodeSqlite();
      sql = observeMainThreadSql({ includeClose: true });
      sql.calibrate();
    }
    await run(createRuntime(), commands);
    await closeOpenClawStateDatabaseAsync();
    sql?.expectIdle();
  } finally {
    restore();
    sql?.restore();
  }
}

function configureRoster(state: OpenClawTestState, ids: string[]) {
  config = {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(ids.map((id) => [id, { workspace: path.join(state.root, id) }])),
    },
  };
}

it(
  "keeps an empty JSON roster free of provenance storage",
  withState(async (state) => {
    configureRoster(state, []);
    await observe(async (runtime, commands) => {
      await agentsListCommand({ json: true }, runtime);
      expect(runtime.writeJson.mock.calls[0]?.[0]).toEqual([]);
      expect(commands).toEqual([]);
      expect(existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);
    });
  }),
);

it(
  "reads absent provenance without creating state or parent SQL",
  withState(async (state) => {
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    expect(existsSync(databasePath)).toBe(false);
    await observe(async () => {
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
    }, true);
  }),
);

it(
  "serves JSON and tree output from worker provenance through reopen",
  withState(async (state) => {
    configureRoster(state, ["main", "child", "legacy"]);
    await recordAgentProvenance("Main", { createdVia: "operator" }, { env: state.env, nowMs: 10 });
    await recordAgentProvenance(
      "Child",
      { createdVia: "agent", creatorAgentId: "Main" },
      { env: state.env, nowMs: 20 },
    );
    await recordAgentProvenance("retired", { createdVia: "claw" }, { env: state.env, nowMs: 30 });
    await closeOpenClawStateDatabaseAsync();
    await observe(async (runtime, commands) => {
      await agentsListCommand({ json: true }, runtime);
      const output = runtime.writeJson.mock.calls[0]?.[0];
      expect(output).toEqual([
        expect.objectContaining({ id: "main", createdVia: "operator", createdAt: 10 }),
        expect.objectContaining({
          id: "child",
          createdVia: "agent",
          creatorAgentId: "main",
          createdAt: 20,
        }),
        expect.objectContaining({ id: "legacy" }),
      ]);
      if (Array.isArray(output)) {
        expect(output[2]).not.toHaveProperty("createdVia");
      }
      await waitForDiagnosticEventsDrained();
      expect(commands).toEqual(["stateRead"]);
      await agentsListCommand({ tree: true }, runtime);
      expect(runtime.log).toHaveBeenCalledWith("Agents:\n- main\n  - child\n- legacy");
      await closeOpenClawStateDatabaseAsync();
      expect((await listAgentProvenance({ env: state.env })).map((row) => row.agentId)).toEqual([
        "child",
        "main",
        "retired",
      ]);
    }, true);
  }),
);

it(
  "enriches growing rosters with bounded requests in configured order",
  withState(async (state) => {
    const ids = Array.from({ length: 300 }, (_, index) => `worker-${299 - index}`);
    configureRoster(state, ids);
    for (const [index, id] of ids.entries()) {
      await recordAgentProvenance(id, { createdVia: "operator" }, { env: state.env, nowMs: index });
    }
    await closeOpenClawStateDatabaseAsync();
    await observe(async (runtime, commands) => {
      await agentsListCommand({ json: true }, runtime);
      expect(runtime.writeJson.mock.calls[0]?.[0]).toEqual(
        ids.map((id, index) =>
          expect.objectContaining({ id, createdVia: "operator", createdAt: index }),
        ),
      );
      await waitForDiagnosticEventsDrained();
      expect(commands).toEqual(["stateRead", "stateRead"]);
    });
  }),
);
