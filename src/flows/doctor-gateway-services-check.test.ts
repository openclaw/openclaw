import { beforeEach, expect, it, vi } from "vitest";
import type { ExtraGatewayService, GatewayServiceInventory } from "../daemon/inspect.js";
import { createCoreHealthChecks } from "./doctor-core-checks.js";

const mocks = vi.hoisted(() => ({
  detectExtraGatewayServiceIssues: vi.fn<() => Promise<GatewayServiceInventory>>(),
}));
vi.mock("../commands/doctor-gateway-services.js", () => ({
  detectExtraGatewayServiceIssues: mocks.detectExtraGatewayServiceIssues,
}));
const runtime = { log() {}, error() {}, exit() {} };
const inspectionError = (source: string) => ({
  source,
  message: "Service path could not be inspected.",
});
const check = createCoreHealthChecks().find(
  (entry) => entry.id === "core/doctor/gateway-services/extra",
)!;

function service(
  platform: ExtraGatewayService["platform"],
  label: string,
  scope: ExtraGatewayService["scope"] = "user",
  legacy = true,
): ExtraGatewayService {
  const detail = platform === "linux" ? `unit: /home/test/.config/systemd/user/${label}` : label;
  return { platform, label, scope, legacy, detail };
}

beforeEach(() => mocks.detectExtraGatewayServiceIssues.mockClear());

it.each([
  [true, false],
  [false, false],
  [false, true],
] as const)(
  "reports inventory with verified cleanup (dryRun=%s, empty=%s)",
  async (dryRun, empty) => {
    mocks.detectExtraGatewayServiceIssues.mockResolvedValue({
      services: empty
        ? []
        : [
            service("linux", "custom-gateway.service", "user", false),
            service("darwin", "ai.clawdbot.gateway"),
            service("linux", "clawdbot-gateway.service"),
            service("win32", "Clawdbot Gateway"),
            { ...service("linux", "clawdbot-gateway-custom.service"), marker: "clawdbot" },
            service("linux", "clawdbot-system.service", "system"),
            service("darwin", "ai.clawdbot.system", "system"),
          ],
      errors: [inspectionError(empty ? "clawdbot-gateway.service" : "clawdbot-backup.service")],
    });
    const ctx = { mode: "fix" as const, runtime, cfg: {}, deep: true, dryRun };
    const findings = await check.detect(ctx);
    const result = await check.repair?.(ctx, findings);
    expect(mocks.detectExtraGatewayServiceIssues).toHaveBeenCalledWith({ deep: true });
    if (empty) {
      expect(findings).toMatchObject([
        {
          severity: "warning",
          target: "clawdbot-gateway.service",
          message: expect.stringContaining("could not be inspected"),
        },
      ]);
    } else {
      expect(findings).toMatchObject([
        {
          checkId: "core/doctor/gateway-services/extra",
          severity: "info",
          source: "linux",
          target: "custom-gateway.service",
          message:
            "Other gateway-like service detected: custom-gateway.service (user, unit: /home/test/.config/systemd/user/custom-gateway.service)",
          fixHint: "Run a single gateway per machine unless this extra gateway is intentional.",
        },
        { target: "ai.clawdbot.gateway" },
        {
          severity: "warning",
          target: "clawdbot-gateway.service",
          message:
            "Other gateway-like service detected: clawdbot-gateway.service (user, unit: /home/test/.config/systemd/user/clawdbot-gateway.service)",
          fixHint:
            "Run `openclaw doctor` interactively to review legacy gateway services and confirm supported cleanup.",
        },
        { target: "Clawdbot Gateway" },
        { target: "clawdbot-gateway-custom.service" },
        { target: "clawdbot-system.service" },
        { target: "ai.clawdbot.system" },
        {
          checkId: "core/doctor/gateway-services/extra",
          severity: "warning",
          target: "clawdbot-backup.service",
          message: expect.stringContaining("Service path could not be inspected."),
        },
      ]);
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
