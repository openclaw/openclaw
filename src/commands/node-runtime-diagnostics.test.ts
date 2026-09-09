import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDoctorContributionHealthChecks } from "../flows/doctor-health-contributions.js";
import { statusCommand } from "./status.command.js";

const service = vi.hoisted(() => ({
  readCommand: vi.fn(),
  resolveNodeRuntimeInfo: vi.fn(),
}));
const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  isDefaultInstallIdentity: () => true,
}));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: service.readCommand }),
}));
vi.mock("../daemon/runtime-paths.js", () => ({
  resolveNodeRuntimeInfo: service.resolveNodeRuntimeInfo,
}));
vi.mock("./status-json-command.ts", () => ({
  assertStatusUsageAgentScope: () => {},
  runStatusJsonCommand: async () => {},
}));

beforeEach(() => {
  vi.clearAllMocks();
  service.readCommand.mockResolvedValue({
    programArguments: ["/fixture/node", "openclaw.mjs", "gateway"],
  });
  service.resolveNodeRuntimeInfo.mockResolvedValue({
    status: "unsupported",
    version: "22.23.2",
    sqliteVersion: "3.50.2",
    nodeSharedSqlite: false,
  });
  vi.stubGlobal("process", { ...process, versions: { ...process.versions, node: "26.8.1" } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Node runtime diagnostics command surfaces", () => {
  it("registers Doctor findings for the CLI and recorded service runtimes", async () => {
    vi.stubGlobal("process", { ...process, versions: { ...process.versions, node: "26.0.0" } });
    const checks = await resolveDoctorContributionHealthChecks();
    const check = checks.find((entry) => entry.id === "core/doctor/node-runtime");
    expect(check).toBeDefined();
    const findings = await check?.detect({ mode: "lint", cfg: {}, runtime, env: {} });
    expect(findings).toEqual([
      expect.objectContaining({ source: "cli", message: expect.stringContaining("26.0.0") }),
      expect.objectContaining({
        source: "gateway-service",
        message: expect.stringContaining("22.23.2"),
        fixHint: expect.stringContaining("nvm install 26"),
      }),
    ]);
  });

  it("warns about a stale service Node without mixing text into status JSON", async () => {
    await statusCommand({ json: true }, runtime);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Gateway service Node 22.23.2"),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("https://openclaw.ai/install.sh"),
    );
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("reports an uninspectable service without claiming its Node is unsupported", async () => {
    service.resolveNodeRuntimeInfo.mockResolvedValue({
      status: "probe-failed",
      error: new Error("unavailable"),
    });
    await statusCommand({ json: true }, runtime);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("could not be inspected"));
    expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("is unsupported"));
  });
});
