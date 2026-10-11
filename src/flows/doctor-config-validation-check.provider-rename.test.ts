import { describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "../commands/test-runtime-config-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { finalConfigValidationCheck } from "./doctor-config-validation-check.js";
import type { DoctorHealthCheckContext } from "./doctor-health-contribution-types.js";

// mock-isolation: Supply plugin declarations without real plugin discovery or persisted auth reads.
vi.mock("../plugins/doctor-contract-registry.js", () => ({
  resolvePluginDoctorProviderRenames: () => [
    { from: "ollama", to: "ollama-cloud", baseUrl: "https://ollama.com" },
  ],
}));

describe("Doctor lint provider rename preview", () => {
  it.each([
    { baseUrl: "https://OLLAMA.com/api/", planned: true },
    { baseUrl: "http://127.0.0.1:11434", planned: false },
  ])("previews $baseUrl without replacing the captured config", async ({ baseUrl, planned }) => {
    const cfg: OpenClawConfig = {
      models: {
        providers: { ollama: { api: "ollama", baseUrl, models: [] } },
      },
      agents: { defaults: { model: "ollama/example", models: { "ollama/example": {} } } },
    };
    const before = structuredClone(cfg);
    const ctx: DoctorHealthCheckContext = {
      mode: "lint",
      cfg,
      runtime: createTestRuntime(),
      lintConfigSnapshot: { exists: true, issues: [], warnings: [] },
    };
    const findings = await finalConfigValidationCheck.detect(ctx);
    expect(findings.some((finding) => finding.message.includes("ollama-cloud"))).toBe(planned);
    if (planned) {
      expect(findings.some((finding) => finding.message.includes("agents.defaults.models"))).toBe(
        true,
      );
      expect(findings.every((finding) => finding.fixHint?.includes("doctor --fix"))).toBe(true);
    }
    expect(ctx.cfg).toBe(cfg);
    expect(cfg).toEqual(before);
  });
});
