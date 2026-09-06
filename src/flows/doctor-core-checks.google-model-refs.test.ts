// Doctor model-reference checks against the bundled google plugin manifest catalog.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createCoreHealthChecks } from "./doctor-core-checks.js";
import { clearHealthChecksForTest } from "./health-check-registry.js";
import type { HealthCheck } from "./health-checks.js";

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalog: vi.fn(async () => []),
}));

vi.mock("../commands/doctor-gateway-services.js", () => ({
  detectExtraGatewayServiceIssues: vi.fn(async (): Promise<readonly { label: string }[]> => []),
  extraGatewayServiceToHealthFinding: vi.fn(),
  extraGatewayServiceToRepairEffects: vi.fn(() => []),
}));

vi.mock("../claws/doctor.js", () => ({
  collectClawStateHealthFindings: vi.fn(async () => []),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

const runtime = { log() {}, error() {}, exit() {} };

function getCheck(checks: readonly HealthCheck[], id: string): HealthCheck {
  const check = checks.find((entry) => entry.id === id);
  if (!check) {
    throw new Error(`Missing health check ${id}`);
  }
  return check;
}

describe("CORE_HEALTH_CHECKS google model references", () => {
  beforeAll(() => {
    clearHealthChecksForTest();
  });

  afterEach(() => {
    clearHealthChecksForTest();
  });

  it("recognizes bundled Google static models as known and still flags genuine unknowns", async () => {
    const check = getCheck(createCoreHealthChecks(), "core/doctor/model-references");

    const findings = await check.detect({
      mode: "doctor",
      runtime,
      cfg: {
        agents: {
          defaults: {
            model: {
              primary: "google/gemini-2.5-flash",
              fallbacks: ["google/gemini-3.8-flash"],
            },
          },
        },
      },
    });

    // The bundled google plugin ships gemini-2.5-flash in its static catalog,
    // so Doctor must not warn about it as an unknown local model.
    expect(findings).not.toContainEqual(
      expect.objectContaining({ target: "google/gemini-2.5-flash" }),
    );
    // A model absent from both the manifest mirror and the runtime static list
    // stays a genuine unknown so typos keep being surfaced.
    expect(findings).toContainEqual(
      expect.objectContaining({
        severity: "info",
        target: "google/gemini-3.8-flash",
        fixHint:
          "Verify the model id with the provider, or rerun with --severity-min info after refreshing the local catalog.",
      }),
    );
  });

  it("keeps the legacy Gemini CLI migration hint after the google manifest catalog mirror", async () => {
    const check = getCheck(createCoreHealthChecks(), "core/doctor/model-references");

    const findings = await check.detect({
      mode: "doctor",
      runtime,
      cfg: {
        agents: {
          defaults: {
            model: { primary: "google-gemini-cli/gemini-2.5-pro" },
          },
        },
      },
    });

    // The manifest mirror is scoped to the canonical google provider, so the
    // legacy CLI reference stays unknown-model and Doctor keeps offering the
    // migration to the canonical ref instead of silently accepting it.
    expect(findings).toContainEqual(
      expect.objectContaining({
        target: "google-gemini-cli/gemini-2.5-pro",
        message: expect.stringContaining("legacy reference"),
        fixHint: expect.stringContaining("openclaw doctor --fix"),
      }),
    );
  });
});
