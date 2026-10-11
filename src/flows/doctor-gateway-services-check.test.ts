import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtraGatewayService, GatewayServiceInventory } from "../daemon/inspect.js";
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

function service(
  platform: ExtraGatewayService["platform"],
  label: string,
  scope: ExtraGatewayService["scope"] = "user",
  legacy = true,
): ExtraGatewayService {
  const location =
    platform === "linux"
      ? `unit: ${scope === "user" ? "/home/test/.config/systemd/user" : "/etc/systemd/system"}/${label}`
      : platform === "darwin"
        ? `plist: ${scope === "user" ? "/Users/test/Library/LaunchAgents" : "/Library/LaunchDaemons"}/${label}.plist`
        : `task: ${label}`;
  return { platform, label, scope, legacy, detail: location };
}

beforeEach(() => {
  mocks.detectExtraGatewayServiceIssues.mockClear();
  mocks.detectExtraGatewayServiceIssues.mockResolvedValue({ services: [], errors: [] });
});

describe("registered Gateway service health", () => {
  it.each([
    { dryRun: true, empty: false },
    { dryRun: false, empty: false },
    { dryRun: false, empty: true },
  ])(
    "reports inventory and offers only verified legacy cleanup (dryRun=$dryRun, empty=$empty)",
    async ({ dryRun, empty }) => {
      const check = gatewayServicesCheck();
      mocks.detectExtraGatewayServiceIssues.mockResolvedValue(
        empty
          ? {
              services: [],
              errors: [
                {
                  source: "clawdbot-gateway.service",
                  message: "Service path could not be inspected.",
                },
              ],
            }
          : {
              services: [
                service("linux", "custom-gateway.service", "user", false),
                service("darwin", "ai.clawdbot.gateway"),
                service("linux", "clawdbot-gateway.service"),
                service("win32", "Clawdbot Gateway"),
                { ...service("linux", "clawdbot-gateway-custom.service"), marker: "clawdbot" },
                service("linux", "clawdbot-system.service", "system"),
                service("darwin", "ai.clawdbot.system", "system"),
              ],
              errors: [
                {
                  source: "clawdbot-backup.service",
                  message: "Service path could not be inspected.",
                },
              ],
            },
      );
      const ctx = { mode: "fix" as const, runtime, cfg: {}, deep: true, dryRun };
      const findings = await check.detect(ctx);
      const result = await check.repair?.(ctx, findings);
      expect(mocks.detectExtraGatewayServiceIssues).toHaveBeenCalledWith({ deep: true });
      if (empty) {
        expect(findings).toEqual([
          expect.objectContaining({
            severity: "warning",
            target: "clawdbot-gateway.service",
            message: expect.stringContaining("could not be inspected"),
          }),
        ]);
      } else {
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
        expect(findings[0]).toMatchObject({
          checkId: "core/doctor/gateway-services/extra",
          severity: "info",
          source: "linux",
          target: "custom-gateway.service",
          message:
            "Other gateway-like service detected: custom-gateway.service (user, unit: /home/test/.config/systemd/user/custom-gateway.service)",
          fixHint: "Run a single gateway per machine unless this extra gateway is intentional.",
        });
        expect(findings[2]).toMatchObject({
          checkId: "core/doctor/gateway-services/extra",
          severity: "warning",
          source: "linux",
          target: "clawdbot-gateway.service",
          message:
            "Other gateway-like service detected: clawdbot-gateway.service (user, unit: /home/test/.config/systemd/user/clawdbot-gateway.service)",
          fixHint:
            "Run `openclaw doctor` interactively to review legacy gateway services and confirm supported cleanup.",
        });
        expect(findings[7]).toMatchObject({
          checkId: "core/doctor/gateway-services/extra",
          severity: "warning",
          target: "clawdbot-backup.service",
          message: expect.stringContaining("Service path could not be inspected."),
        });
      }
      expect(result).toEqual({
        status: dryRun ? "repaired" : "skipped",
        ...(dryRun ? {} : { reason: "legacy doctor gateway service contribution owns cleanup" }),
        changes: [],
        effects: empty
          ? []
          : ["ai.clawdbot.gateway", "clawdbot-gateway.service"].map((target) => ({
              kind: "service",
              action: "would-remove-legacy-gateway-service",
              target,
              dryRunSafe: false,
            })),
      });
    },
  );
});
