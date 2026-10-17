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

function instrumentParentSql() {
  requireNodeSqlite();
  const sql = observeMainThreadSql({ includeClose: true });
  try {
    sql.calibrate();
    return sql;
  } catch (error) {
    sql.restore();
    throw error;
  }
}

function instrumentProvenanceWorkerRequests() {
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
  return { commands, restore };
}

it("does not create provenance storage for an empty JSON roster", async () => {
  await withOpenClawTestState(
    { layout: "state-only", label: "provenance-empty-roster" },
    async (state) => {
      state.applyEnv();
      config = { agents: { ownership: "explicit", entries: {} } };
      recordAgentDatabaseAdmissions([], { env: state.env });
      const runtime = { ...createTestRuntime(), writeStdout: vi.fn(), writeJson: vi.fn() };
      const requests = instrumentProvenanceWorkerRequests();
      try {
        await agentsListCommand({ json: true }, runtime);
        expect(runtime.writeJson.mock.calls[0]?.[0]).toEqual([]);
        expect(requests.commands).toEqual([]);
        expect(existsSync(resolveOpenClawStateSqlitePath(state.env))).toBe(false);
      } finally {
        requests.restore();
        await closeOpenClawStateDatabaseAsync();
      }
    },
  );
});

it("reads an absent provenance database without creating state or executing parent SQL", async () => {
  await withOpenClawTestState({ layout: "state-only", label: "provenance-cold" }, async (state) => {
    const databasePath = resolveOpenClawStateSqlitePath(state.env);
    expect(existsSync(databasePath)).toBe(false);
    const sql = instrumentParentSql();
    try {
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
      await closeOpenClawStateDatabaseAsync();
      sql.expectIdle();
    } finally {
      sql.restore();
      await closeOpenClawStateDatabaseAsync();
    }
  });
});

it("serves actual JSON and tree command output from worker provenance through reopen", async () => {
  await withOpenClawTestState({ layout: "state-only", label: "provenance-cli" }, async (state) => {
    state.applyEnv();
    config = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: path.join(state.root, "main") },
          child: { workspace: path.join(state.root, "child") },
          legacy: { workspace: path.join(state.root, "legacy") },
        },
      },
    };
    recordAgentDatabaseAdmissions([], { env: state.env });
    await recordAgentProvenance("Main", { createdVia: "operator" }, { env: state.env, nowMs: 10 });
    await recordAgentProvenance(
      "Child",
      { createdVia: "agent", creatorAgentId: "Main" },
      { env: state.env, nowMs: 20 },
    );
    await recordAgentProvenance("retired", { createdVia: "claw" }, { env: state.env, nowMs: 30 });
    await closeOpenClawStateDatabaseAsync();
    const runtime = {
      ...createTestRuntime(),
      writeStdout: vi.fn<(value: string) => void>(),
      writeJson: vi.fn<(value: unknown) => void>(),
    };
    const sql = instrumentParentSql();
    const requests = instrumentProvenanceWorkerRequests();
    try {
      await agentsListCommand({ json: true }, runtime);
      expect(runtime.writeJson.mock.calls[0]?.[0]).toEqual([
        expect.objectContaining({ id: "main", createdVia: "operator", createdAt: 10 }),
        expect.objectContaining({
          id: "child",
          createdVia: "agent",
          creatorAgentId: "main",
          createdAt: 20,
        }),
        expect.objectContaining({ id: "legacy" }),
      ]);
      const output = runtime.writeJson.mock.calls[0]?.[0];
      if (Array.isArray(output)) {
        expect(output[2]).not.toHaveProperty("createdVia");
      }
      await waitForDiagnosticEventsDrained();
      expect(requests.commands).toEqual(["stateRead"]);
      await agentsListCommand({ tree: true }, runtime);
      expect(runtime.log).toHaveBeenCalledWith("Agents:\n- main\n  - child\n- legacy");
      await closeOpenClawStateDatabaseAsync();
      expect((await listAgentProvenance({ env: state.env })).map((row) => row.agentId)).toEqual([
        "child",
        "main",
        "retired",
      ]);
      await closeOpenClawStateDatabaseAsync();
      sql.expectIdle();
    } finally {
      requests.restore();
      sql.restore();
      await closeOpenClawStateDatabaseAsync();
    }
  });
});

it("enriches a growing configured roster with bounded worker requests in configured order", async () => {
  await withOpenClawTestState(
    { layout: "state-only", label: "provenance-large-roster" },
    async (state) => {
      state.applyEnv();
      const ids = Array.from({ length: 300 }, (_, index) => `worker-${299 - index}`);
      config = {
        agents: {
          ownership: "explicit",
          entries: Object.fromEntries(
            ids.map((id) => [id, { workspace: path.join(state.root, id) }]),
          ),
        },
      };
      recordAgentDatabaseAdmissions([], { env: state.env });
      for (const [index, id] of ids.entries()) {
        await recordAgentProvenance(
          id,
          { createdVia: "operator" },
          { env: state.env, nowMs: index },
        );
      }
      await closeOpenClawStateDatabaseAsync();
      const runtime = { ...createTestRuntime(), writeStdout: vi.fn(), writeJson: vi.fn() };
      const requests = instrumentProvenanceWorkerRequests();
      try {
        await agentsListCommand({ json: true }, runtime);
        expect(runtime.writeJson.mock.calls[0]?.[0]).toEqual(
          ids.map((id, index) =>
            expect.objectContaining({ id, createdVia: "operator", createdAt: index }),
          ),
        );
        await waitForDiagnosticEventsDrained();
        expect(requests.commands).toEqual(["stateRead", "stateRead"]);
      } finally {
        requests.restore();
        await closeOpenClawStateDatabaseAsync();
      }
    },
  );
});
