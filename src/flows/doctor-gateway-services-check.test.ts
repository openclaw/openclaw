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
      errors: [{ source: "unreadable.service", message: "Service path could not be inspected." }],
    });
    const ctx = { mode: "fix" as const, runtime, cfg: {}, deep: true, dryRun };
    const findings = await check.detect(ctx);
    const result = await check.repair?.(ctx, findings);
    expect(findings.at(-1)).toMatchObject({
      target: "unreadable.service",
      severity: "warning",
      message: expect.stringContaining("Service path could not be inspected."),
    });
    if (empty) {
      expect(findings).toHaveLength(1);
    } else {
      expect(findings[0]).toMatchObject({
        severity: "info",
        fixHint: expect.stringContaining("Run a single gateway"),
      });
      expect(findings[1]).toMatchObject({
        severity: "warning",
        fixHint: expect.stringContaining("confirm supported cleanup"),
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
