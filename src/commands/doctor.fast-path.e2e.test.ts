import { beforeAll, describe, expect, it } from "vitest";
import {
  createDoctorRuntime,
  detectLegacyStateMigrations,
  ensureAuthProfileStore,
  findExtraGatewayServices,
  mockDoctorConfigSnapshot,
} from "./doctor.e2e-harness.js";
import "./doctor.fast-path-mocks.js";

let doctorCommand: typeof import("./doctor.js").doctorCommand;
let checkGatewayHealth: typeof import("./doctor-gateway-health.js").checkGatewayHealth;
let probeGatewayMemoryStatus: typeof import("./doctor-gateway-health.js").probeGatewayMemoryStatus;
let maybeRepairGatewayDaemon: typeof import("./doctor-gateway-daemon-flow.js").maybeRepairGatewayDaemon;
let noteChromeMcpBrowserReadiness: typeof import("./doctor-browser.js").noteChromeMcpBrowserReadiness;
let noteMemorySearchHealth: typeof import("./doctor-memory-search.js").noteMemorySearchHealth;
let noteStateIntegrity: typeof import("./doctor-state-integrity.js").noteStateIntegrity;
let noteWorkspaceStatus: typeof import("./doctor-workspace-status.js").noteWorkspaceStatus;

describe("doctor command fast path", () => {
  beforeAll(async () => {
    ({ doctorCommand } = await import("./doctor.js"));
    ({ checkGatewayHealth, probeGatewayMemoryStatus } = await import("./doctor-gateway-health.js"));
    ({ maybeRepairGatewayDaemon } = await import("./doctor-gateway-daemon-flow.js"));
    ({ noteChromeMcpBrowserReadiness } = await import("./doctor-browser.js"));
    ({ noteMemorySearchHealth } = await import("./doctor-memory-search.js"));
    ({ noteStateIntegrity } = await import("./doctor-state-integrity.js"));
    ({ noteWorkspaceStatus } = await import("./doctor-workspace-status.js"));
  });

  it("skips expensive checks in non-interactive default mode", async () => {
    mockDoctorConfigSnapshot();

    await doctorCommand(createDoctorRuntime(), {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    expect(ensureAuthProfileStore).not.toHaveBeenCalled();
    expect(detectLegacyStateMigrations).not.toHaveBeenCalled();
    expect(noteStateIntegrity).not.toHaveBeenCalled();
    expect(findExtraGatewayServices).not.toHaveBeenCalled();
    expect(noteChromeMcpBrowserReadiness).not.toHaveBeenCalled();
    expect(noteWorkspaceStatus).not.toHaveBeenCalled();
    expect(checkGatewayHealth).not.toHaveBeenCalled();
    expect(probeGatewayMemoryStatus).not.toHaveBeenCalled();
    expect(noteMemorySearchHealth).not.toHaveBeenCalled();
    expect(maybeRepairGatewayDaemon).not.toHaveBeenCalled();
  });

  it("does not print the generic doctor --fix hint for a clean read-only config", async () => {
    mockDoctorConfigSnapshot();
    const runtime = createDoctorRuntime();

    await doctorCommand(runtime, {
      nonInteractive: true,
      workspaceSuggestions: false,
    });

    const logOutput = runtime.log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logOutput).not.toContain("openclaw doctor --fix");
  });
});
