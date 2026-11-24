import { beforeEach, expect, it, vi } from "vitest";
import { createMockGatewayService } from "../daemon/service.test-helpers.js";
import { statusJsonCommand } from "./status-json.js";
import { statusCommand } from "./status.command.js";

const mocks = vi.hoisted(() => ({
  scan: vi.fn(),
  overview: vi.fn(),
  gateway: vi.fn(),
  node: vi.fn(),
}));
vi.mock("./node-runtime-diagnostics.js", () => ({ collectNodeRuntimeFindings: async () => [] }));
vi.mock("./status.scan.js", () => ({ scanStatus: mocks.scan }));
vi.mock("./status.scan.fast-json.js", () => ({ scanStatusJsonFast: mocks.scan }));
// mock-isolation: Inject scan failures without starting live status or database probes.
vi.mock("./status.scan-overview.ts", () => ({
  collectStatusScanOverview: mocks.overview,
  prepareStatusSummaryFromOverview: vi.fn(),
}));
vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: () => createMockGatewayService(),
  readGatewayServiceState: mocks.gateway,
}));
vi.mock("../daemon/node-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/node-service.js")>()),
  resolveNodeService: mocks.node,
}));
vi.mock("../infra/openclaw-root.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/openclaw-root.js")>()),
  resolveOpenClawPackageRoot: async () => "/prefix-b/lib/node_modules/openclaw",
}));
vi.mock("../daemon/service-layout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service-layout.js")>()),
  summarizeGatewayServiceLayout: async () => undefined,
  inspectGatewayServiceInstallationDrift: async () => ({
    serviceRoot: "/prefix-a/lib/node_modules/openclaw",
    activeRoot: "/prefix-b/lib/node_modules/openclaw",
    serviceVersion: "2026.9.4",
    activeVersion: "2026.9.17",
  }),
}));
vi.mock("../cli/daemon-cli/shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cli/daemon-cli/shared.js")>()),
  formatGatewayServiceInstallationDrift: () => `\u001b[2J${installationDrift}`,
}));

const installationDrift =
  "Gateway service targets a different OpenClaw install: /prefix-a/lib/node_modules/openclaw (2026.9.4); active CLI: /prefix-b/lib/node_modules/openclaw (2026.9.17). Run `openclaw doctor --fix` or `openclaw gateway install --force` from the active CLI.";

beforeEach(() => vi.clearAllMocks());

it.each([
  ["text", false],
  ["fast JSON", false],
  ["all", false],
  ["text", true],
  ["fast JSON", true],
  ["all", true],
] as const)(
  "preserves schema refusal (%s, service inspection unavailable=%s)",
  async (mode, unavailable) => {
    const timeoutMs = mode === "fast JSON" ? 2345 : undefined;
    const original = new Error(
      "OpenClaw agent database /state/agents/main/agent.sqlite uses schema version 19; stop active agents and run openclaw doctor --fix to upgrade it to schema version 32 before using it.",
    );
    mocks.scan.mockRejectedValue(original);
    mocks.overview.mockRejectedValue(original);
    if (unavailable) {
      mocks.gateway.mockRejectedValue(new Error("native service inspection unavailable"));
    } else {
      mocks.gateway.mockResolvedValue({
        installed: false,
        loadState: { status: "not-loaded" },
        running: false,
        command: null,
        env: {},
      });
    }
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    const result =
      mode === "fast JSON"
        ? statusJsonCommand({ timeoutMs }, runtime)
        : statusCommand({ all: mode === "all", timeoutMs }, runtime);
    await expect(result).rejects.toBe(original);
    expect(mocks.gateway).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ timeoutMs: timeoutMs ?? 5000 }),
    );
    expect(mocks.node).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
    if (unavailable) {
      expect(runtime.error).not.toHaveBeenCalled();
    } else {
      expect(runtime.error).toHaveBeenCalledExactlyOnceWith(installationDrift);
    }
  },
);
