import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const testState = vi.hoisted(() => ({ loadedConfigRuntime: false, output: undefined as unknown }));

vi.mock("./command-execution-startup.js", () => ({
  applyCliExecutionStartupPresentation: vi.fn(async () => {}),
  ensureCliExecutionBootstrap: vi.fn(async () => {}),
}));

vi.mock("../config/io.runtime.js", async (importOriginal) => {
  testState.loadedConfigRuntime = true;
  return await importOriginal();
});

vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: () => ({ label: "Gateway" }),
  readGatewayServiceState: async () => ({
    command: null,
    env: {},
    loadState: { status: "not-loaded" as const },
    runtime: { status: "stopped" as const },
  }),
}));

vi.mock("../gateway/control-ui-links.js", () => ({
  resolveAdvertisedControlUiLinks: async () => ({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  }),
}));

vi.mock("../gateway/desktop/host-source.js", () => ({
  inspectHostDesktop: async () => ({ status: { enabled: false, state: "disabled" } }),
}));

vi.mock("../infra/network-discovery-display.js", () => ({
  inspectBestEffortPrimaryTailnetIPv4: () => ({ tailnetIPv4: undefined }),
  resolveBestEffortGatewayBindHostForDisplay: async () => ({ bindHost: "127.0.0.1" }),
}));

vi.mock("../infra/ports-inspect.js", () => ({
  inspectPortConnections: async (port: number) => ({ port, connections: [] }),
  inspectPortUsage: async (port: number) => ({ port, status: "free", listeners: [], hints: [] }),
  inspectPortUsages: async () => new Map(),
}));

vi.mock("../plugins/installed-plugin-index-record-reader.js", () => ({
  loadInstalledPluginIndexInstallRecords: async () => ({}),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
    writeJson: vi.fn((value: unknown) => Object.assign(testState, { output: value })),
    writeStdout: vi.fn(),
  },
}));

import { tryRouteCli } from "./route.js";

const tempRoot = useAutoCleanupTempDirTracker(afterAll).make("openclaw-gateway-status-route-");
const configPath = path.join(tempRoot, "openclaw.json");
fs.writeFileSync(configPath, JSON.stringify({ gateway: { bind: "loopback" } }));

afterAll(() => vi.unstubAllEnvs());

it("keeps plain-config status off the full config runtime", async () => {
  vi.stubEnv("OPENCLAW_HOME", tempRoot);
  vi.stubEnv("OPENCLAW_STATE_DIR", tempRoot);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);

  await expect(
    tryRouteCli(["node", "openclaw", "gateway", "status", "--json", "--no-probe"]),
  ).resolves.toBe(true);

  expect(testState.output).toMatchObject({
    config: { cli: { path: configPath, exists: true, valid: true } },
    gateway: { bindMode: "loopback", port: 18789 },
  });
  expect(testState.loadedConfigRuntime).toBe(false);
});
