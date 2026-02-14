import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBindMode } from "../config/types.gateway.js";
import { dashboardCommand } from "./dashboard.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveGatewayPort: vi.fn(),
  resolveControlUiLinks: vi.fn(),
  copyToClipboard: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("./onboard-helpers.js", () => ({
  resolveControlUiLinks: mocks.resolveControlUiLinks,
  detectBrowserOpenSupport: vi.fn(),
  openUrl: vi.fn(),
  formatControlUiSshHint: vi.fn(() => "ssh hint"),
}));

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function mockSnapshot(params?: {
  token?: string;
  bind?: GatewayBindMode;
  customBindHost?: string;
}) {
  const token = params?.token ?? "abc123";
  mocks.readConfigFileSnapshot.mockResolvedValue({
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    valid: true,
    config: {
      gateway: {
        auth: { token },
        bind: params?.bind,
        customBindHost: params?.customBindHost,
      },
    },
    issues: [],
    legacyIssues: [],
  });
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.resolveControlUiLinks.mockReturnValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
  mocks.copyToClipboard.mockResolvedValue(true);
}

describe("dashboardCommand bind selection", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockReset();
    mocks.resolveGatewayPort.mockReset();
    mocks.resolveControlUiLinks.mockReset();
    mocks.copyToClipboard.mockReset();
    runtime.log.mockReset();
    runtime.error.mockReset();
    runtime.exit.mockReset();
  });

  it("maps lan bind to loopback for dashboard URLs", async () => {
    mockSnapshot({ bind: "lan" });

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
      port: 18789,
      bind: "loopback",
      customBindHost: undefined,
      basePath: undefined,
    });
  });

  it("defaults to loopback when bind is unset", async () => {
    mockSnapshot();

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
      port: 18789,
      bind: "loopback",
      customBindHost: undefined,
      basePath: undefined,
    });
  });

  it("preserves custom bind mode", async () => {
    mockSnapshot({ bind: "custom", customBindHost: "10.0.0.5" });

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
      port: 18789,
      bind: "custom",
      customBindHost: "10.0.0.5",
      basePath: undefined,
    });
  });

  it("preserves tailnet bind mode", async () => {
    mockSnapshot({ bind: "tailnet" });

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
      port: 18789,
      bind: "tailnet",
      customBindHost: undefined,
      basePath: undefined,
    });
  });
});
