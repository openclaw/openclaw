import { beforeAll, describe, expect, it, vi } from "vitest";
import "./doctor.fast-path-mocks.js";
import {
  createDoctorRuntime,
  mockDoctorConfigSnapshot,
  readConfigFileSnapshot,
} from "./doctor.e2e-harness.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;
let checkGatewayHealthMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  ({ doctorCommand } = await import("./doctor.js"));
  const mod = await import("./doctor-gateway-health.js");
  checkGatewayHealthMock = mod.checkGatewayHealth as unknown as ReturnType<typeof vi.fn>;
});

/** Override checkGatewayHealth to report healthy gateway. */
function mockHealthOk() {
  checkGatewayHealthMock.mockResolvedValue({ healthOk: true });
}

describe("doctor exit codes", () => {
  it("exits with code 1 when gateway.mode is unset", async () => {
    mockDoctorConfigSnapshot();

    const runtime = createDoctorRuntime();
    await doctorCommand(runtime, { nonInteractive: true, workspaceSuggestions: false });

    expect(runtime.exit).toHaveBeenCalledWith(1);
  }, 30_000);

  it("exits with code 1 when gateway health check fails", async () => {
    mockDoctorConfigSnapshot({ config: { gateway: { mode: "local" } } });
    // fast-path-mocks defaults checkGatewayHealth to { healthOk: false }

    const runtime = createDoctorRuntime();
    await doctorCommand(runtime, { nonInteractive: true, workspaceSuggestions: false });

    expect(runtime.exit).toHaveBeenCalledWith(1);
  }, 30_000);

  it("exits with code 1 when config is invalid", async () => {
    mockDoctorConfigSnapshot({
      config: { gateway: { mode: "local" } },
      valid: false,
      issues: [{ path: "foo", message: "invalid value" }],
    });
    mockHealthOk();

    // readConfigFileSnapshot is called again at the end for final validation
    readConfigFileSnapshot.mockResolvedValue({
      path: "/tmp/openclaw.json",
      exists: true,
      raw: '{"gateway":{"mode":"local"}}',
      parsed: { gateway: { mode: "local" } },
      valid: false,
      config: { gateway: { mode: "local" } },
      issues: [{ path: "foo", message: "invalid value" }],
      legacyIssues: [],
    });

    const runtime = createDoctorRuntime();
    await doctorCommand(runtime, { nonInteractive: true, workspaceSuggestions: false });

    expect(runtime.exit).toHaveBeenCalledWith(1);
  }, 30_000);

  it("does not exit with error when all checks pass", async () => {
    mockDoctorConfigSnapshot({ config: { gateway: { mode: "local" } } });
    mockHealthOk();

    const runtime = createDoctorRuntime();
    await doctorCommand(runtime, { nonInteractive: true, workspaceSuggestions: false });

    expect(runtime.exit).not.toHaveBeenCalled();
  }, 30_000);

  it("does not exit with error for warnings only", async () => {
    mockDoctorConfigSnapshot({
      config: {
        gateway: { mode: "local" },
        hooks: { gmail: { model: "invalid-model" } },
      },
    });
    mockHealthOk();

    const runtime = createDoctorRuntime();
    await doctorCommand(runtime, { nonInteractive: true, workspaceSuggestions: false });

    expect(runtime.exit).not.toHaveBeenCalled();
  }, 30_000);
});
