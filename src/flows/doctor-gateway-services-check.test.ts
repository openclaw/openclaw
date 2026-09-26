import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayServiceInventory } from "../daemon/inspect.js";
import { createCoreHealthChecks } from "./doctor-core-checks.js";
import type { HealthCheck } from "./health-checks.js";

const mocks = vi.hoisted(() => ({
  detectExtraGatewayServiceIssues: vi.fn(async (): Promise<GatewayServiceInventory> => ({
    services: [],
    errors: [],
  })),
}));
vi.mock("../commands/doctor-gateway-services.js", () => ({
  detectExtraGatewayServiceIssues: mocks.detectExtraGatewayServiceIssues,
}));
const runtime = { log() {}, error() {}, exit() {} };

function gatewayServicesCheck(): HealthCheck {
  const check = createCoreHealthChecks().find(
    (entry) => entry.id === "core/doctor/gateway-services/extra",
  );
  if (!check) {
    throw new Error("Gateway service check is not registered");
  }
  return check;
}

beforeEach(() => {
  mocks.detectExtraGatewayServiceIssues.mockClear();
  mocks.detectExtraGatewayServiceIssues.mockResolvedValue({ services: [], errors: [] });
});

describe("registered Gateway service health", () => {
  it("reports verified extras and incomplete inspection through the registered check", async () => {
    const check = gatewayServicesCheck();
    mocks.detectExtraGatewayServiceIssues.mockResolvedValueOnce({
      services: [
        {
          platform: "linux",
          label: "custom-gateway.service",
          detail: "unit: /etc/systemd/system/custom-gateway.service",
          scope: "system",
          legacy: false,
        },
        {
          platform: "linux",
          label: "clawdbot-gateway.service",
          detail: "unit: /home/test/.config/systemd/user/clawdbot-gateway.service",
          scope: "user",
          legacy: true,
        },
      ],
      errors: [{ source: "schtasks", message: "Scheduled tasks could not be queried." }],
    });

    const ctx = { mode: "lint" as const, runtime, cfg: {}, deep: true };
    const findings = await check.detect(ctx);

    expect(mocks.detectExtraGatewayServiceIssues).toHaveBeenCalledWith({ deep: true });
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/gateway-services/extra",
        severity: "info",
        source: "linux",
        target: "custom-gateway.service",
        message:
          "Other gateway-like service detected: custom-gateway.service (system, unit: /etc/systemd/system/custom-gateway.service)",
        fixHint: "Run a single gateway per machine unless this extra gateway is intentional.",
      }),
      expect.objectContaining({
        checkId: "core/doctor/gateway-services/extra",
        severity: "warning",
        source: "linux",
        target: "clawdbot-gateway.service",
        message:
          "Other gateway-like service detected: clawdbot-gateway.service (user, unit: /home/test/.config/systemd/user/clawdbot-gateway.service)",
        fixHint:
          "Run `openclaw doctor` interactively to review legacy gateway services and confirm supported cleanup.",
      }),
      expect.objectContaining({
        checkId: "core/doctor/gateway-services/extra",
        severity: "warning",
        target: "schtasks",
        message: expect.stringContaining("Scheduled tasks could not be queried."),
      }),
    ]);
  });

  it.each([true, false])(
    "never turns incomplete inspection into cleanup effects (dryRun=%s)",
    async (dryRun) => {
      const check = gatewayServicesCheck();
      mocks.detectExtraGatewayServiceIssues.mockResolvedValue({
        services: [],
        errors: [
          { source: "clawdbot-gateway.service", message: "Service path could not be inspected." },
        ],
      });
      const ctx = { mode: "fix" as const, runtime, cfg: {}, deep: true, dryRun };

      const findings = await check.detect(ctx);
      const result = await check.repair?.(ctx, findings);

      expect(findings).toEqual([
        expect.objectContaining({
          severity: "warning",
          target: "clawdbot-gateway.service",
          message: expect.stringContaining("could not be inspected"),
        }),
      ]);
      expect(result).toMatchObject({
        status: dryRun ? "repaired" : "skipped",
        changes: [],
        effects: [],
      });
    },
  );

  it.each([true, false])(
    "offers only supported legacy user-service cleanup through the registered check (dryRun=%s)",
    async (dryRun) => {
      const check = gatewayServicesCheck();
      mocks.detectExtraGatewayServiceIssues.mockResolvedValue({
        services: [
          {
            platform: "linux",
            label: "custom-gateway.service",
            detail: "unit: /home/test/.config/systemd/user/custom-gateway.service",
            scope: "user",
            legacy: false,
          },
          {
            platform: "darwin",
            label: "ai.clawdbot.gateway",
            detail: "plist: /Users/test/Library/LaunchAgents/ai.clawdbot.gateway.plist",
            scope: "user",
            legacy: true,
          },
          {
            platform: "linux",
            label: "clawdbot-gateway.service",
            detail: "unit: /home/test/.config/systemd/user/clawdbot-gateway.service",
            scope: "user",
            legacy: true,
          },
          {
            platform: "win32",
            label: "Clawdbot Gateway",
            detail: "task: Clawdbot Gateway",
            scope: "user",
            legacy: true,
          },
          {
            platform: "linux",
            label: "clawdbot-gateway-custom.service",
            detail: "unit: /home/test/.config/systemd/user/clawdbot-gateway-custom.service",
            scope: "user",
            marker: "clawdbot",
            legacy: true,
          },
          {
            platform: "linux",
            label: "clawdbot-system.service",
            detail: "unit: /etc/systemd/system/clawdbot-system.service",
            scope: "system",
            legacy: true,
          },
          {
            platform: "darwin",
            label: "ai.clawdbot.system",
            detail: "plist: /Library/LaunchDaemons/ai.clawdbot.system.plist",
            scope: "system",
            legacy: true,
          },
        ],
        errors: [
          { source: "clawdbot-backup.service", message: "Service path could not be inspected." },
        ],
      });
      const ctx = { mode: "fix" as const, runtime, cfg: {}, deep: true, dryRun };

      const findings = await check.detect(ctx);
      const result = await check.repair?.(ctx, findings);

      expect(mocks.detectExtraGatewayServiceIssues).toHaveBeenCalledWith({ deep: true });
      expect(findings.map((finding) => finding.target)).toEqual([
        "custom-gateway.service",
        "ai.clawdbot.gateway",
        "clawdbot-gateway.service",
        "Clawdbot Gateway",
        "clawdbot-gateway-custom.service",
        "clawdbot-system.service",
        "ai.clawdbot.system",
        "clawdbot-backup.service",
      ]);
      expect(result).toEqual({
        status: dryRun ? "repaired" : "skipped",
        ...(dryRun ? {} : { reason: "legacy doctor gateway service contribution owns cleanup" }),
        changes: [],
        effects: [
          {
            kind: "service",
            action: "would-remove-legacy-gateway-service",
            target: "ai.clawdbot.gateway",
            dryRunSafe: false,
          },
          {
            kind: "service",
            action: "would-remove-legacy-gateway-service",
            target: "clawdbot-gateway.service",
            dryRunSafe: false,
          },
        ],
      });
    },
  );
});
