import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import * as gatewayCall from "../gateway/call.js";
import {
  completeGatewayBootLifecycle,
  recordGatewayBootStart,
} from "../infra/gateway-boot-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { checkGatewayHealth, collectGatewayHealthFindings } from "./doctor-gateway-health.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  buildGatewayProbeConnectionDetails: vi.fn(),
  hasActiveGatewayExecCredential: vi.fn(),
  note: vi.fn(),
}));
vi.mock("../flows/doctor-gateway-exec-credential.js", () => ({
  hasActiveGatewayExecCredential: mocks.hasActiveGatewayExecCredential,
}));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: async () => null }),
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  });
});
const reason = "gateway.installation_replaced: on-disk 2026.9.5 differs from running 2026.9.4";
const completedAtMs = Date.UTC(2026, 8, 19, 12);

beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-doctor-replacement-"));
  mocks.callGateway.mockReset().mockResolvedValue({});
  mocks.buildGatewayProbeConnectionDetails
    .mockReset()
    .mockResolvedValue({ url: "ws://127.0.0.1:18789" });
  vi.spyOn(gatewayCall, "callGateway").mockImplementation(mocks.callGateway);
  vi.spyOn(gatewayCall, "buildGatewayProbeConnectionDetails").mockImplementation(
    mocks.buildGatewayProbeConnectionDetails,
  );
  mocks.hasActiveGatewayExecCredential.mockReset().mockResolvedValue(false);
  mocks.note.mockReset();
  const bootId = recordGatewayBootStart(process.env, completedAtMs - 1_000);
  completeGatewayBootLifecycle(
    bootId,
    { outcome: "planned_restart", reason },
    process.env,
    completedAtMs,
  );
  recordGatewayBootStart(process.env, completedAtMs + 1_000);
});

describe("Doctor installation replacement diagnostics", () => {
  it.each([true, false])(
    "reports historical replacement without changing current health (reachable: %s)",
    async (reachable) => {
      if (!reachable) {
        mocks.callGateway.mockRejectedValue(new Error("Gateway unavailable"));
      }
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const result = await checkGatewayHealth({ cfg: {}, runtime });

      expect(mocks.callGateway).toHaveBeenCalledWith(expect.objectContaining({ method: "status" }));
      expect(result.healthOk).toBe(reachable);
      expect(mocks.note).toHaveBeenCalledWith(
        `Previous installation replacement (${new Date(completedAtMs).toISOString()}): ${reason}`,
        "Previous Gateway installation replacement",
      );
    },
  );

  it.each(["healthy", "offline", "unprepared", "exec"])(
    "preserves lint history when the current probe is %s",
    async (probe) => {
      if (probe === "offline") {
        mocks.callGateway.mockRejectedValue(new Error("Gateway unavailable"));
      }
      if (probe === "unprepared") {
        mocks.buildGatewayProbeConnectionDetails.mockRejectedValue(
          new Error("Invalid Gateway URL"),
        );
      }
      if (probe === "exec") {
        mocks.hasActiveGatewayExecCredential.mockResolvedValue(true);
      }

      const findings = await collectGatewayHealthFindings({ cfg: {}, env: process.env });

      expect(findings).toContainEqual(
        expect.objectContaining({
          checkId: "core/doctor/gateway-health",
          severity: "info",
          message: `Previous installation replacement (${new Date(completedAtMs).toISOString()}): ${reason}`,
        }),
      );
      if (probe === "healthy") {
        expect(findings).toHaveLength(1);
      } else {
        expect(findings).toContainEqual(expect.objectContaining({ severity: "warning" }));
      }
      if (probe === "unprepared" || probe === "exec") {
        expect(mocks.callGateway).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["normal", "lint"])(
    "does not attribute local history to remote %s checks",
    async (mode) => {
      const cfg: OpenClawConfig = {
        gateway: { mode: "remote", remote: { url: "wss://gateway.example" } },
      };
      if (mode === "lint") {
        expect(await collectGatewayHealthFindings({ cfg })).toEqual([]);
      } else {
        await checkGatewayHealth({ cfg, runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } });
        expect(mocks.note.mock.calls.map(([, title]) => title)).not.toContain(
          "Previous Gateway installation replacement",
        );
      }
    },
  );

  it("reports the live replacement as a warning separately from historical information", async () => {
    const installationReplacementWarning =
      "Installation replaced: on-disk 2026.9.5 differs from running 2026.9.4; draining active work.";
    mocks.callGateway.mockResolvedValue({ installationReplacementWarning });

    const findings = await collectGatewayHealthFindings({ cfg: {} });

    expect(findings).toContainEqual(expect.objectContaining({ severity: "info" }));
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/gateway-health",
        severity: "warning",
        message: installationReplacementWarning,
      }),
    );
  });
});
