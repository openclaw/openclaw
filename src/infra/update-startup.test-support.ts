import { vi } from "vitest";
import type { prepareUpdate } from "../update/run.js";

const {
  checkTelemetryUpdateMock,
  detectRespawnSupervisorMock,
  getRuntimeConfigMock,
  prepareUpdateMock,
  runUpdateFailureTriageMock,
  refreshRemoteModelCatalogMock,
  scheduleGatewayRestartMock,
  versionMock,
} = vi.hoisted(() => ({
  checkTelemetryUpdateMock: vi.fn<typeof import("./telemetry.js").checkTelemetryUpdate>(),
  detectRespawnSupervisorMock: vi.fn(),
  getRuntimeConfigMock: vi.fn(() => ({})),
  prepareUpdateMock: vi.fn<typeof prepareUpdate>(),
  runUpdateFailureTriageMock: vi.fn<typeof import("./update-triage.js").runUpdateFailureTriage>(),
  refreshRemoteModelCatalogMock: vi.fn<
    typeof import("../model-catalog/remote-refresh.js").refreshRemoteModelCatalog
  >(async () => ({
    status: "unchanged" as const,
    providers: 1,
    models: 1,
    generatedAt: 1_753_500_000_000,
  })),
  scheduleGatewayRestartMock: vi.fn(() => ({ scheduled: true })),
  versionMock: { value: "1.0.0" },
}));

// mock-isolation: Use fixture configuration without reading operator state.
vi.mock("../config/config.js", () => ({ getRuntimeConfig: getRuntimeConfigMock }));

vi.mock("./update-triage.js", () => ({ runUpdateFailureTriage: runUpdateFailureTriageMock }));

vi.mock("../model-catalog/remote-refresh.js", async (original) => ({
  ...(await original<typeof import("../model-catalog/remote-refresh.js")>()),
  refreshRemoteModelCatalog: refreshRemoteModelCatalogMock,
}));

vi.mock("./openclaw-root.js", async (original) => ({
  ...(await original<typeof import("./openclaw-root.js")>()),
  resolveOpenClawPackageRoot: vi.fn(),
}));

vi.mock("./restart.js", async () => ({
  ...(await vi.importActual<typeof import("./restart.js")>("./restart.js")),
  scheduleGatewayRestart: scheduleGatewayRestartMock,
}));

vi.mock("./supervisor-markers.js", async (original) => ({
  ...(await original<typeof import("./supervisor-markers.js")>()),
  detectRespawnSupervisor: detectRespawnSupervisorMock,
}));

// mock-isolation: Observe startup telemetry without making network requests.
vi.mock("./telemetry.js", () => ({ checkTelemetryUpdate: checkTelemetryUpdateMock }));

vi.mock("./update-check.js", async (original) => {
  const actual = await original<typeof import("./update-check.js")>();
  return {
    ...actual,
    checkUpdateStatus: vi.fn(),
    resolveNpmChannelTag: vi.fn(),
  };
});

vi.mock("../version.js", () => ({
  get VERSION() {
    return versionMock.value;
  },
}));

// mock-isolation: Startup fixtures must not execute updater commands.
vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: vi.fn() }));

vi.mock("../update/run.js", async (original) => ({
  ...(await original<typeof import("../update/run.js")>()),
  prepareUpdate: prepareUpdateMock,
}));

export {
  checkTelemetryUpdateMock,
  detectRespawnSupervisorMock,
  getRuntimeConfigMock,
  prepareUpdateMock,
  runUpdateFailureTriageMock,
  refreshRemoteModelCatalogMock,
  scheduleGatewayRestartMock,
  versionMock,
};
