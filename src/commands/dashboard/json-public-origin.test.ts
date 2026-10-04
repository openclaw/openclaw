import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardCommand } from "../dashboard.js";
import { createTestRuntime } from "../test-runtime-config-helpers.js";

// A configured `gateway.publicOrigin` must not change the destination that same-host
// consumers already depend on (the Linux desktop app runs `dashboard --json --no-open`
// and opens the reported browserUrl locally). The public origin is therefore exported
// separately, re-using the same one-time grant.
//
// This lane keeps the real link resolution (`resolveControlUiLinks`) and the real
// handoff producer (`resolveControlUiHandoffTarget`, `issueControlUiBrowserHandoff`,
// `retargetControlUiHandoffUrl`) and mocks only I/O: config read, port probe,
// bootstrap issuance, browser-open support and readiness.
const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  detectBrowserOpenSupport: vi.fn(),
  ensureGatewayReadyForOperation: vi.fn(),
  inspectPortUsage: vi.fn(),
  issueDeviceBootstrapToken: vi.fn(),
  openUrl: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveGatewayPort: vi.fn(),
  waitForControlUiDocument: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../onboard-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../onboard-helpers.js")>()),
  detectBrowserOpenSupport: mocks.detectBrowserOpenSupport,
  openUrl: mocks.openUrl,
}));

vi.mock("../../infra/clipboard.js", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

vi.mock("../../infra/device-bootstrap.js", () => ({
  issueDeviceBootstrapToken: mocks.issueDeviceBootstrapToken,
}));

vi.mock("../../infra/ports-inspect.js", () => ({
  inspectPortUsage: mocks.inspectPortUsage,
}));

vi.mock("../gateway-readiness.js", () => ({
  ensureGatewayReadyForOperation: mocks.ensureGatewayReadyForOperation,
}));

vi.mock("../control-ui-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../control-ui-handoff.js")>()),
  waitForControlUiDocument: mocks.waitForControlUiDocument,
}));

const runtime = {
  ...createTestRuntime(),
  writeJson: vi.fn(),
  writeStdout: vi.fn(),
};

function readyDashboard(gateway: Record<string, unknown>): void {
  mocks.readConfigFileSnapshot.mockResolvedValue({
    valid: true,
    sourceConfig: { gateway },
  });
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.issueDeviceBootstrapToken.mockResolvedValue({
    token: "browser-bootstrap",
    expiresAtMs: 123_456,
  });
  mocks.inspectPortUsage.mockResolvedValue({
    port: 18789,
    status: "busy",
    listeners: [],
    hints: [],
  });
  mocks.ensureGatewayReadyForOperation.mockResolvedValue({
    ready: true,
    recovered: false,
    status: {},
  });
  mocks.waitForControlUiDocument.mockResolvedValue({ ready: true });
}

/** Read the reported destinations without asserting on the private payload type. */
function readDestinations(): { browserUrl: string; publicBrowserUrl: string | null } {
  const payload: unknown = runtime.writeJson.mock.calls[0]?.[0];
  if (typeof payload !== "object" || payload === null || !("browserUrl" in payload)) {
    throw new Error("dashboard --json did not report a browserUrl");
  }
  const { browserUrl } = payload;
  if (typeof browserUrl !== "string") {
    throw new Error("dashboard --json reported a non-string browserUrl");
  }
  const publicUrl = "publicBrowserUrl" in payload ? payload.publicBrowserUrl : null;
  return { browserUrl, publicBrowserUrl: typeof publicUrl === "string" ? publicUrl : null };
}

function fragmentGatewayUrl(url: string): string | null {
  return new URLSearchParams(new URL(url).hash.slice(1)).get("gatewayUrl");
}

function fragmentBootstrapToken(url: string): string | null {
  return new URLSearchParams(new URL(url).hash.slice(1)).get("bootstrapToken");
}

describe("dashboardCommand --json handoff destinations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the local destination and exports the configured public origin separately", async () => {
    readyDashboard({
      bind: "loopback",
      controlUi: { basePath: "/dashboard" },
      publicOrigin: "https://public.example.com",
      auth: { token: "test" },
    });

    await dashboardCommand(runtime, { json: true, noOpen: true });

    const { browserUrl, publicBrowserUrl } = readDestinations();
    // Same-host contract unchanged: the default link still names the local endpoint.
    expect(new URL(browserUrl).origin).toBe("http://127.0.0.1:18789");
    expect(fragmentGatewayUrl(browserUrl)).toBe("ws://127.0.0.1:18789/dashboard");
    // The public origin is available as an explicit, separately addressed export.
    expect(publicBrowserUrl).not.toBeNull();
    expect(new URL(publicBrowserUrl ?? "").origin).toBe("https://public.example.com");
    expect(fragmentGatewayUrl(publicBrowserUrl ?? "")).toBe("wss://public.example.com/dashboard");
    // Both views carry the same single-use grant rather than minting a second one.
    expect(fragmentBootstrapToken(publicBrowserUrl ?? "")).toBe(fragmentBootstrapToken(browserUrl));
  });

  it("omits the public export when no public origin is configured", async () => {
    readyDashboard({
      bind: "loopback",
      controlUi: { basePath: "/dashboard" },
      auth: { token: "test" },
    });

    await dashboardCommand(runtime, { json: true, noOpen: true });

    const { browserUrl, publicBrowserUrl } = readDestinations();
    expect(publicBrowserUrl).toBeNull();
    expect(fragmentGatewayUrl(browserUrl)).toBe("ws://127.0.0.1:18789/dashboard");
  });

  it("omits the public export while the Control UI is disabled", async () => {
    readyDashboard({
      bind: "loopback",
      controlUi: { enabled: false, basePath: "/dashboard" },
      publicOrigin: "https://public.example.com",
      auth: { token: "test" },
    });

    await dashboardCommand(runtime, { json: true, noOpen: true });

    expect(readDestinations().publicBrowserUrl).toBeNull();
  });

  it("keeps the locally opened pairing URL on the bind-derived endpoint", async () => {
    readyDashboard({
      bind: "loopback",
      controlUi: { basePath: "/dashboard" },
      publicOrigin: "https://public.example.com",
      auth: { token: "test" },
    });
    mocks.detectBrowserOpenSupport.mockResolvedValue({ ok: true });
    mocks.openUrl.mockResolvedValue(true);
    mocks.copyToClipboard.mockResolvedValue(true);

    await dashboardCommand(runtime, {});

    const opened: unknown = mocks.openUrl.mock.calls[0]?.[0];
    const copied: unknown = mocks.copyToClipboard.mock.calls[0]?.[0];
    if (typeof opened !== "string" || typeof copied !== "string") {
      throw new Error("expected the interactive command to open and copy a pairing URL");
    }
    expect(new URL(opened).origin).toBe("http://127.0.0.1:18789");
    expect(fragmentGatewayUrl(opened)).toBe("ws://127.0.0.1:18789/dashboard");
    expect(copied).toBe(opened);
  });
});
