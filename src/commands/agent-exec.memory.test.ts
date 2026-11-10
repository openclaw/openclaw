import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runLocalAgentCommand } from "../agents/agent-command-local.js";
import type { AgentCommandOpts } from "../agents/command/types.js";
import {
  getPreparedModelRuntimeBorrowedSnapshot,
  getPreparedModelRuntimePluginGeneration,
} from "../agents/prepared-model-runtime-generation-scope.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import { getRuntimeConfigSnapshot } from "../config/io.js";
import { getMemoryRuntime, registerMemoryCapability } from "../plugins/memory-state.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  withOpenClawAgentDatabaseAsync,
} from "../state/openclaw-agent-db.js";
import { agentExecCommand } from "./agent-exec.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  agent: vi.fn<typeof import("./agent.js").agentCommand>(),
  prepare: vi.fn(),
}));
// mock-isolation: Replace model execution while retaining the local command's real generation lease.
vi.mock("./agent.js", () => ({ agentCommand: mocks.agent }));
// mock-isolation: Supply command inputs without preparing a model or session for the synthetic turn.
vi.mock("../agents/command/prepare.js", () => ({ prepareAgentCommandExecution: mocks.prepare }));
// mock-isolation: This command lifecycle proof does not use channel delivery dependencies.
vi.mock("../agents/command/runtime-loaders.js", () => ({
  resolveAgentCommandDeps: async () => ({}),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  mocks.agent.mockReset();
  mocks.prepare.mockReset();
});

it.each([false, true])(
  "settles memory inside the temporary command generation (close failure: %s)",
  async (closeFailure) => {
    const workspace = tempDirs.make("openclaw-exec-memory-workspace-");
    const witness = path.join(workspace, "memory-closed.json");
    let runStateDir = "";
    let agentPath = "";
    mocks.prepare.mockImplementation(async (opts: AgentCommandOpts) => ({
      cfg: getRuntimeConfigSnapshot(),
      opts,
      runId: "memory-cleanup",
      sessionId: opts.sessionId,
      sessionAgentId: "main",
      agentDir: path.join(runStateDir, "agents", "main", "agent"),
      workspaceDir: workspace,
    }));
    mocks.agent.mockImplementation(async (opts, runtime = createTestRuntime()) => {
      runStateDir = process.env.OPENCLAW_STATE_DIR!;
      return await runLocalAgentCommand({
        opts,
        runtime,
        run: async () => {
          const generation = getPreparedModelRuntimePluginGeneration();
          if (!generation) {
            throw new Error("Local command did not acquire a plugin generation");
          }
          await fs.writeFile(path.join(runStateDir, "memory-reindex"), "pending index");
          await withOpenClawAgentDatabaseAsync({ agentId: "main" }, (database) => {
            agentPath = database.path;
            registerMemoryCapability("memory-exec-fixture", {
              runtime: {
                getMemorySearchManager: async () => ({ manager: null }),
                resolveMemoryBackendConfig: () => ({ backend: "builtin" }),
                async closeAllMemorySearchManagers() {
                  if (!getPreparedModelRuntimeBorrowedSnapshot(generation)) {
                    throw new Error("Memory cleanup lost its prepared generation lease");
                  }
                  const row = database.db.prepare("SELECT 1 AS value").get();
                  const contents = await fs.readFile(
                    path.join(runStateDir, "memory-reindex"),
                    "utf8",
                  );
                  await fs.writeFile(witness, JSON.stringify({ row, contents }));
                  if (closeFailure) {
                    throw new Error("Memory provider close failed");
                  }
                },
              },
            });
          });
          expect(getMemoryRuntime()).toBeDefined();
          return { payloads: [{ text: "done", mediaUrl: null }], meta: { durationMs: 1 } };
        },
      });
    });
    try {
      const result = await agentExecCommand(
        "inspect",
        { authEnvOnly: true, cwd: workspace },
        createTestRuntime(),
      );
      expect(result.envelope.final, JSON.stringify(result.envelope.error)).toBe("done");
      expect(getMemoryRuntime()).toBeUndefined();
      expect(JSON.parse(await fs.readFile(witness, "utf8"))).toEqual({
        row: { value: 1 },
        contents: "pending index",
      });
      expect(result.exitCode).toBe(closeFailure ? 1 : 0);
      if (closeFailure) {
        expect(result.envelope).toMatchObject({ ok: false, error: { kind: "cleanup" } });
        await expect(fs.readFile(path.join(runStateDir, "memory-reindex"), "utf8")).resolves.toBe(
          "pending index",
        );
      } else {
        await expect(fs.stat(runStateDir)).rejects.toMatchObject({ code: "ENOENT" });
      }
    } finally {
      await resetPreparedModelRuntimeSnapshotsForTest();
      if (agentPath) {
        await closeOpenClawAgentDatabaseByPathAsync(agentPath);
      }
      if (runStateDir) {
        await fs.rm(runStateDir, { recursive: true, force: true });
      }
    }
  },
);
