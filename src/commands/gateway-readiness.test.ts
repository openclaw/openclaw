import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DaemonStatus } from "../cli/daemon-cli/status.gather.js";
import { createCliTtyMock } from "../cli/test-runtime-capture.js";
import { dashboardCommand } from "./dashboard.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const { gatherStatus, confirm, installGateway, startGateway } = vi.hoisted(() => ({
  gatherStatus: vi.fn(),
  confirm: vi.fn(),
  installGateway: vi.fn(),
  startGateway: vi.fn(),
}));
vi.mock("../cli/daemon-cli/status.gather.js", () => ({ gatherDaemonStatus: gatherStatus }));
vi.mock("../cli/prompt.js", () => ({ promptYesNo: confirm }));
vi.mock("../cli/daemon-cli/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/daemon-cli/install.js")>()),
  runDaemonInstall: installGateway,
}));
vi.mock("../cli/daemon-cli/lifecycle.js", () => ({ runDaemonStart: startGateway }));
vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: async () => ({ ...baseConfigSnapshot, sourceConfig: {} }),
}));
vi.mock("./control-ui-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-ui-handoff.js")>()),
  resolveControlUiHandoffTarget: async () => ({
    port: 18789,
    bind: "loopback",
    links: { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" },
    authMode: "token",
    includeTokenInUrl: false,
    dashboardUrl: "http://127.0.0.1:18789/",
    documentUrl: "http://127.0.0.1:18789/",
    probeUrl: "ws://127.0.0.1:18789",
  }),
  waitForControlUiDocument: async () => ({ ready: true }),
  issueControlUiBrowserHandoff: async () => ({ browserUrl: "http://127.0.0.1:18789/" }),
}));
vi.mock("../infra/clipboard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clipboard.js")>()),
  copyToClipboard: async () => true,
}));

const portStatus = (status: "free" | "busy", port = 18789) => ({
  port,
  status,
  listeners: [],
  hints: [],
});

const runtime = createTestRuntime();
const tty = createCliTtyMock();
let status: DaemonStatus;
beforeEach(() => {
  vi.resetAllMocks();
  status = {
    service: {
      label: "systemd user",
      loaded: false,
      loadState: { status: "not-loaded" },
      loadedText: "enabled",
      notLoadedText: "disabled",
      command: null,
      runtime: { status: "stopped" },
    },
    port: portStatus("free"),
    rpc: { ok: false, error: "connect ECONNREFUSED 127.0.0.1:18789" },
    extraServices: [],
  };
  gatherStatus.mockResolvedValue(status);
});
afterEach(() => tty.restore());
const output = () => runtime.log.mock.calls.flat().join("\n");
const check = (options: { yes?: boolean } = {}) =>
  dashboardCommand(runtime, { noOpen: true, ...options });
function expectNoRecovery() {
  for (const action of [confirm, installGateway, startGateway]) {
    expect(action).not.toHaveBeenCalled();
  }
}
it("does not start over a busy listener after an inconclusive timeout probe", async () => {
  status.port = portStatus("busy");
  status.rpc = { ok: false, error: "timeout" };

  await check();

  expect(output()).not.toContain("Dashboard URL:");
  expectNoRecovery();
  expect(output()).toContain("Gateway check failed:");
  expect(output()).not.toContain("Gateway is not running");
  expect(output()).not.toContain("gateway start");
});

it("prints diagnosis and skips recovery when an interactive user declines", async () => {
  tty.set(true);
  confirm.mockResolvedValue(false);

  await check();

  expect(output()).not.toContain("Dashboard URL:");
  expect(confirm).toHaveBeenCalledWith(
    "No background Gateway service was detected for this profile. Install and start one to open the dashboard?",
    true,
  );
  expect(output()).toContain("Gateway is not running.");
});

it.each([false, true])("recovers a stopped gateway (installed=%s)", async (installed) => {
  status.service.command = installed ? { programArguments: ["openclaw", "gateway", "run"] } : null;
  gatherStatus
    .mockResolvedValueOnce(status)
    .mockResolvedValueOnce({ ...status, rpc: { ok: true } });

  await check({ yes: true });

  expect(output()).toContain("Dashboard URL: http://127.0.0.1:18789/");
  expect(installGateway).toHaveBeenCalledTimes(installed ? 0 : 1);
  expect(startGateway).toHaveBeenCalledTimes(installed ? 1 : 0);
});

it("does not recover a diagnostic-only native service for an active external target", async () => {
  status.service = {
    ...status.service,
    loaded: true,
    loadState: { status: "loaded" },
    runtime: { status: "running" },
    targetRole: "diagnostic-only",
    command: { programArguments: ["openclaw", "gateway", "run", "--port", "18789"] },
  };
  status.port = portStatus("free", 18900);
  status.rpc = {
    ok: false,
    error: "connect ECONNREFUSED 127.0.0.1:18900",
    url: "ws://127.0.0.1:18900",
  };

  await check();

  expect(output()).not.toContain("Dashboard URL:");
  expectNoRecovery();
  expect(output()).toContain("owning environment or supervisor to start or repair");
});

it("can accept a reachable dashboard listener when authenticated RPC fails", async () => {
  status.portCli = portStatus("busy", 49876);
  status.rpc = {
    ok: false,
    error: "gateway closed (1008): auth failed",
    gatewayReached: true,
    url: "ws://127.0.0.1:49876",
  };

  await check();

  expect(output()).toContain("Dashboard URL: http://127.0.0.1:18789/");
  expectNoRecovery();
  expect(output()).not.toContain("Gateway check failed:");
});
