import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import { startGatewayDiagnosticHeartbeat } from "../logging/diagnostic.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createGatewayDiagnosticsConfigurator } from "./server-diagnostics.js";

vi.mock("../logging/diagnostic.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/diagnostic.js")>()),
  startGatewayDiagnosticHeartbeat: vi.fn(),
  stopGatewayDiagnosticHeartbeat: vi.fn(),
}));

const qaEnv = {
  OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
  OPENCLAW_GATEWAY_HOST_LIFELINE: " stdin ",
  QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS: "30000",
};

describe("Gateway diagnostics QA timing overrides", () => {
  let wasEnabled: boolean;
  beforeEach(() => {
    wasEnabled = areDiagnosticsEnabledForProcess();
    vi.clearAllMocks();
  });
  afterEach(() => {
    setDiagnosticsEnabledForProcess(wasEnabled);
    vi.unstubAllEnvs();
  });

  it.each([
    {
      env: qaEnv,
      timings: { stuckSessionWarnMs: 15_000, stuckSessionAbortMs: 30_000 },
    },
    { env: { ...qaEnv, OPENCLAW_ENABLE_PRIVATE_QA_CLI: undefined }, timings: undefined },
    { env: { ...qaEnv, OPENCLAW_GATEWAY_HOST_LIFELINE: undefined }, timings: undefined },
    { env: { ...qaEnv, QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS: "29999" }, timings: undefined },
    { env: { ...qaEnv, QA_DIAGNOSTIC_STUCK_SESSION_ABORT_MS: "not-a-number" }, timings: undefined },
  ])("passes only bounded QA child overrides to the heartbeat: $env", ({ env, timings }) => {
    for (const [name, value] of Object.entries(env)) {
      vi.stubEnv(name, value);
    }
    const scheduler = createTestGatewayScheduler();
    onTestFinished(() => scheduler.stop());
    const configureDiagnostics = createGatewayDiagnosticsConfigurator({
      scheduler,
      isClosing: () => false,
      sampleLiveness: () => undefined,
    });
    configureDiagnostics({ diagnostics: { enabled: true } });
    expect(startGatewayDiagnosticHeartbeat).toHaveBeenCalledOnce();
    expect(vi.mocked(startGatewayDiagnosticHeartbeat).mock.calls[0]?.[2]?.testTimings).toEqual(
      timings,
    );
  });
});
