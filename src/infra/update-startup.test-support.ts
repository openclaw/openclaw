import { vi } from "vitest";
import type * as Handoff from "./update-managed-service-handoff.js";

export const {
  cancelManagedServiceUpdateHandoffMock,
  checkTelemetryUpdateMock,
  detectRespawnSupervisorMock,
  getRuntimeConfigMock,
  runUpdateFailureTriageMock,
  refreshRemoteModelCatalogMock,
  scheduleGatewayRestartMock,
  startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoffMock,
  versionMock,
} = vi.hoisted(() => ({
  cancelManagedServiceUpdateHandoffMock: vi.fn<typeof Handoff.cancelManagedServiceUpdateHandoff>(
    async () => "restored-in-process",
  ),
  checkTelemetryUpdateMock: vi.fn<typeof import("./telemetry.js").checkTelemetryUpdate>(),
  detectRespawnSupervisorMock: vi.fn(),
  getRuntimeConfigMock: vi.fn(() => ({})),
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
  startManagedServiceUpdateHandoffMock: vi.fn<typeof Handoff.startManagedServiceUpdateHandoff>(),
  transferManagedServiceUpdateHandoffMock: vi.fn<
    typeof Handoff.transferManagedServiceUpdateHandoff
  >(async () => true),
  versionMock: { value: "1.0.0" },
}));

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

vi.mock("./telemetry.js", () => ({ checkTelemetryUpdate: checkTelemetryUpdateMock }));

vi.mock("./update-check.js", async () => {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10));
  const compareSemverStrings = (a: string, b: string) => {
    const left = parse(a);
    const right = parse(b);
    for (let idx = 0; idx < 3; idx += 1) {
      const l = left[idx] ?? 0;
      const r = right[idx] ?? 0;
      if (l !== r) {
        return l < r ? -1 : 1;
      }
    }
    return 0;
  };

  return {
    checkUpdateStatus: vi.fn(),
    compareSemverStrings,
    resolveNpmChannelTag: vi.fn(),
  };
});

vi.mock("../version.js", () => ({
  get VERSION() {
    return versionMock.value;
  },
}));

vi.mock("../process/exec.js", () => ({ runCommandWithTimeout: vi.fn() }));

vi.mock("./update-managed-service-handoff.js", async () => ({
  ...(await vi.importActual<typeof import("./update-managed-service-handoff.js")>(
    "./update-managed-service-handoff.js",
  )),
  cancelManagedServiceUpdateHandoff: cancelManagedServiceUpdateHandoffMock,
  startManagedServiceUpdateHandoff: startManagedServiceUpdateHandoffMock,
  transferManagedServiceUpdateHandoff: transferManagedServiceUpdateHandoffMock,
}));
