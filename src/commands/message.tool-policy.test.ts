import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import {
  workspaceTestPlugin,
  workspaceConfig,
} from "../infra/outbound/message-action-runner.test-support.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { messageCommand } from "./message.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtime = createThrowingTestRuntime();
const opts = {
  action: "send",
  channel: "workspace",
  target: "C123",
  message: "report ready",
  dryRun: true,
  json: true,
};

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("message-consent-"));
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "workspace", plugin: workspaceTestPlugin, source: "test" }]),
  );
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
});

function pinConfig(tools: AgentToolsConfig) {
  const cfg: OpenClawConfig = {
    ...workspaceConfig,
    agents: {
      defaults: { systemAgent: { agentId: "main" } },
      entries: {
        main: { workspace: path.join(process.env.OPENCLAW_STATE_DIR!, "workspace"), tools },
      },
    },
  };
  // Match the CLI config guard: publication precedes asynchronous command preparation.
  setRuntimeConfigSnapshot(cfg);
}

it.each([{ profile: "full" as const }, { allow: ["message"], deny: ["read"] }])(
  "sends text with a pinned ordinary agent policy %j and cold consent state",
  async (tools) => {
    pinConfig(tools);
    const result = await messageCommand(opts, {}, runtime);
    expect(result).toMatchObject({ kind: "send", channel: "workspace", dryRun: true });
  },
);

it("does not send or repair an unreadable state database", async () => {
  const databasePath = resolveOpenClawStateSqlitePath(process.env);
  mkdirSync(path.dirname(databasePath), { recursive: true });
  writeFileSync(databasePath, "not a sqlite database");
  const before = readFileSync(databasePath);
  pinConfig({ profile: "full", allow: ["read", "message"] });
  await expect(messageCommand(opts, {}, runtime)).rejects.toThrow("file is not a database");
  expect(readFileSync(databasePath)).toEqual(before);
});
