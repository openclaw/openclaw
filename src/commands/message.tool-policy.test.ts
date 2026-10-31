import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import { registerSlackTextPlugin } from "../infra/outbound/message-action-runner.test-support.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import type { TemplateInstallSchemaVersionRow } from "../templates/provenance-runtime-read.kernel.js";
import { messageCommand } from "./message.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const readProvenance = vi.hoisted(() => vi.fn<() => Promise<TemplateInstallSchemaVersionRow[]>>());
// mock-isolation: Supply only persisted consent rows; config, policy, and message dispatch are real.
vi.mock("../state/openclaw-state-worker-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/openclaw-state-worker-store.js")>()),
  runOpenClawStateWorkerOperation: readProvenance,
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runtime = createThrowingTestRuntime();
const opts = {
  action: "send",
  channel: "slack",
  target: "C123",
  message: "report ready",
  dryRun: true,
  json: true,
};

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("message-consent-"));
  readProvenance.mockReset().mockResolvedValue([]);
  resetPluginRuntimeStateForTest();
  registerSlackTextPlugin(["default"], undefined, "direct", {
    normalizeTarget: (raw) => raw,
    targetResolver: { looksLikeId: () => true, hint: "channel ID" },
  });
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
});

function pinConfig(tools: AgentToolsConfig) {
  const cfg: OpenClawConfig = {
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
    expect(result).toMatchObject({ kind: "send", channel: "slack", dryRun: true });
  },
);

it("keeps unverifiable Template consent fail-closed", async () => {
  pinConfig({ profile: "full", allow: ["read", "message"] });
  readProvenance.mockRejectedValue(new Error("unreadable consent database"));
  await expect(messageCommand(opts, {}, runtime)).rejects.toThrow(
    "Cannot verify the installed tool authority",
  );
});
