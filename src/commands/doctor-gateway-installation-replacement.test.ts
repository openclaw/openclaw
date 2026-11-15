import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  reportDoctorHealthFinding,
  showDoctorHealthSummary,
} from "../flows/doctor-health-contribution.js";
import type { HealthFinding } from "../flows/health-checks.js";
import * as gatewayCall from "../gateway/call.js";
import {
  completeGatewayBootLifecycle,
  beginGatewayBootLifecycle,
  readGatewayRecentCrashesAsync,
} from "../infra/gateway-boot-lifecycle.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
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
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  });
});
const reason = "gateway.installation_replaced: on-disk 2026.9.5 differs from running 2026.9.4";
const installationReplacementWarning =
  "Installation replaced: on-disk 2026.9.5 differs from running 2026.9.4; draining active work.";
const completedAtMs = Date.UTC(2026, 8, 19, 12);
const historyMessage = `Previous installation replacement (${new Date(completedAtMs).toISOString()}): ${reason}`;
const historyTitle = "Previous Gateway installation replacement";
const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
function expectFinding(findings: readonly HealthFinding[], finding: Partial<HealthFinding>) {
  expect(findings).toContainEqual(
    expect.objectContaining({ checkId: "core/doctor/gateway-health", ...finding }),
  );
}

beforeEach(async () => {
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
  const bootId = (await beginGatewayBootLifecycle(process.env, completedAtMs - 1_000)).id;
  await completeGatewayBootLifecycle(
    bootId,
    { outcome: "planned_restart", reason },
    process.env,
    completedAtMs,
  );
  await beginGatewayBootLifecycle(process.env, completedAtMs + 1_000);
});

describe("Doctor installation replacement diagnostics", () => {
  it.each([
    { ageMs: 0, count: 1, warns: true },
    { ageMs: 8 * 24 * 60 * 60_000, count: 1, warns: false },
    { ageMs: 2 * 24 * 60 * 60_000, count: 3, warns: true },
    { ageMs: 0, count: 1, warns: true, remote: true },
  ])(
    "reports recent or repeated crashes without marking the successor unhealthy ($ageMs/$count)",
    async ({ ageMs, count, warns, remote }) => {
      const detectedAtMs = Date.now() - ageMs;
      for (let index = 0; index < count; index++) {
        await beginGatewayBootLifecycle(process.env, detectedAtMs + index);
      }
      const cfg: OpenClawConfig = remote
        ? { gateway: { mode: "remote", remote: { url: "wss://gateway.example" } } }
        : {};
      if (remote) {
        mocks.callGateway.mockResolvedValue({
          recentCrashes: await readGatewayRecentCrashesAsync(),
        });
      }
      const findings = await collectGatewayHealthFindings({ cfg, env: process.env });
      const crashFindings = findings.filter((finding) =>
        finding.message.startsWith("Gateway ended unexpectedly"),
      );
      expect(crashFindings).toHaveLength(warns ? 1 : 0);
      if (warns) {
        expect(crashFindings[0]).toMatchObject({ severity: "warning" });
        const ctx = { runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } };
        const result = await checkGatewayHealth({
          cfg,
          runtime: ctx.runtime,
          onFinding: (finding) => reportDoctorHealthFinding(ctx, finding),
        });
        expect(result.healthOk).toBe(true);
        showDoctorHealthSummary(ctx);
        const output = ctx.runtime.log.mock.calls.flat().join("\n");
        expect(output).toContain(`Gateway ended unexpectedly ${count} time(s)`);
        expect(output).toContain("Inspect `openclaw gateway status`");
        expect(ctx.runtime.error).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["normal", "lint"])(
    "reports unavailable history after cancellation without losing %s health results",
    async (mode) => {
      const scope = new AsyncWorkScope();
      const pending = scope.run(() =>
        mode === "lint"
          ? collectGatewayHealthFindings({ cfg: {}, env: process.env })
          : checkGatewayHealth({ cfg: {}, runtime }),
      );
      scope.beginClose(new Error("History inspection deadline"));
      try {
        const result = await pending;
        const message =
          "Previous installation replacement unavailable: History inspection deadline";
        if (mode === "lint") {
          expect(result).toContainEqual(expect.objectContaining({ severity: "warning", message }));
        } else {
          expect(result).toMatchObject({ healthOk: true });
          expect(mocks.note).toHaveBeenCalledWith(message, historyTitle);
        }
      } finally {
        await scope.drain();
      }
    },
  );

  it.each([true, false])(
    "reports historical replacement without changing current health (reachable: %s)",
    async (reachable) => {
      if (!reachable) {
        mocks.callGateway.mockRejectedValue(new Error("Gateway unavailable"));
      }
      const result = await checkGatewayHealth({ cfg: {}, runtime });

      expect(result.healthOk).toBe(reachable);
      expect(mocks.note).toHaveBeenCalledWith(historyMessage, historyTitle);
    },
  );

  it.each(["offline", "unprepared", "exec", "replaced"])(
    "preserves lint history when the current probe is %s",
    async (probe) => {
      if (probe === "replaced") {
        mocks.callGateway.mockResolvedValue({
          installationReplacementWarning,
          modelReasoningWarning: "Model emitted hidden reasoning.",
        });
      }
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

      expectFinding(findings, { severity: "info", message: historyMessage });
      if (probe === "replaced") {
        expectFinding(findings, { severity: "warning", message: installationReplacementWarning });
        expectFinding(findings, {
          severity: "warning",
          message: "Model emitted hidden reasoning.",
          fixHint: "Set reasoning: true on the configured model, or choose a non-thinking model.",
        });
      } else {
        expectFinding(findings, { severity: "warning" });
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
        await checkGatewayHealth({ cfg, runtime });
        expect(mocks.note.mock.calls.map(([, title]) => title)).not.toContain(historyTitle);
      }
    },
  );
});
