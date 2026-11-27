import fs from "node:fs";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./agent-command.test-mocks.js";
import { prepareAgentCommandExecution } from "../agents/command/prepare.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import type * as WorkspaceModule from "../agents/workspace.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const configIoMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));

// mock-isolation: Seeding cases supply workspace config in memory without loading persisted config.
vi.mock("../config/io.js", () => ({
  captureRuntimeConfigAsyncReader: () => async () => configIoMocks.loadConfig(),
  getRuntimeConfig: configIoMocks.loadConfig,
  loadConfig: configIoMocks.loadConfig,
  readConfigFileSnapshotForWrite: configIoMocks.readConfigFileSnapshotForWrite,
}));

const runtime = createThrowingTestRuntime();
const actualWorkspace = await vi.importActual<typeof WorkspaceModule>("../agents/workspace.js");

describe("agent command bootstrap seeding", () => {
  beforeEach(() => {
    vi.mocked(ensureAgentWorkspace)
      .mockReset()
      .mockImplementation(actualWorkspace.ensureAgentWorkspace);
    clearSessionStoreCacheForTest();
  });

  afterEach(closeOpenClawStateDatabaseForTest);

  it.for([
    { oneShotCliRun: true, seeded: false },
    { oneShotCliRun: false, seeded: true },
  ])(
    "seeds the bootstrap ritual only when a later turn can finish it: oneShotCliRun=$oneShotCliRun",
    async ({ oneShotCliRun, seeded }) => {
      await withTempHome(async (home) => {
        const workspace = path.join(home, "openclaw");
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-6" },
              models: { "anthropic/claude-opus-4-6": {} },
              workspace,
            },
          },
          session: { store: path.join(home, "sessions.json"), mainKey: "main" },
        };
        configIoMocks.loadConfig.mockReturnValue(cfg);

        await prepareAgentCommandExecution(
          { message: "hi", agentId: "main", sessionId: "first-run", oneShotCliRun },
          runtime,
        );

        for (const name of ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "BOOTSTRAP.md"]) {
          expect(fs.existsSync(path.join(workspace, name)), name).toBe(seeded);
        }
      });
    },
  );
});
