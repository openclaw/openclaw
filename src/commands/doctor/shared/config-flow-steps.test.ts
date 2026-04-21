import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { DoctorConfigPreflightResult } from "../../doctor-config-preflight.js";
import { applyLegacyCompatibilityStep, applyUnknownConfigKeyStep } from "./config-flow-steps.js";

function createLegacyStepResult(
  snapshot: DoctorConfigPreflightResult["snapshot"],
  doctorFixCommand = "openclaw doctor --fix",
) {
  return applyLegacyCompatibilityStep({
    snapshot,
    state: {
      cfg: {},
      candidate: {},
      pendingChanges: false,
      fixHints: [],
    },
    shouldRepair: false,
    doctorFixCommand,
  });
}

describe("doctor config flow steps", () => {
  it("collects legacy compatibility issue lines and preview fix hints", () => {
    const result = createLegacyStepResult({
      exists: true,
      parsed: { heartbeat: { enabled: true } },
      legacyIssues: [{ path: "heartbeat", message: "use agents.defaults.heartbeat" }],
      path: "/tmp/config.json",
      valid: true,
      issues: [],
      raw: "{}",
      resolved: {},
      sourceConfig: {},
      config: {},
      runtimeConfig: {},
      warnings: [],
    } satisfies DoctorConfigPreflightResult["snapshot"]);

    expect(result.issueLines).toEqual([expect.stringContaining("- heartbeat:")]);
    expect(result.changeLines).not.toEqual([]);
    expect(result.state.fixHints).toContain(
      'Run "openclaw doctor --fix" to migrate legacy config keys.',
    );
    expect(result.state.pendingChanges).toBe(true);
  });

  it("keeps pending repair state for legacy issues even when the snapshot is already normalized", () => {
    const result = createLegacyStepResult({
      exists: true,
      parsed: { talk: { voiceId: "voice-1", modelId: "eleven_v3" } },
      legacyIssues: [
        {
          path: "talk",
          message: "talk.voiceId/talk.voiceAliases/talk.modelId/talk.outputFormat/talk.apiKey",
        },
      ],
      path: "/tmp/config.json",
      valid: true,
      issues: [],
      raw: "{}",
      resolved: {},
      sourceConfig: {},
      config: {},
      runtimeConfig: {},
      warnings: [],
    } satisfies DoctorConfigPreflightResult["snapshot"]);

    expect(result.changeLines).toEqual([]);
    expect(result.state.pendingChanges).toBe(true);
    expect(result.state.fixHints).toContain(
      'Run "openclaw doctor --fix" to migrate legacy config keys.',
    );
  });

  it("reports unknown keys without removing them in preview mode", () => {
    const candidateWithCustomKey = { bogus: true } as unknown as OpenClawConfig;
    const result = applyUnknownConfigKeyStep({
      state: {
        cfg: {},
        candidate: candidateWithCustomKey,
        pendingChanges: false,
        fixHints: [],
      },
      shouldRepair: false,
      doctorFixCommand: "openclaw doctor --fix",
    });

    // Unknown keys are detected and reported…
    expect(result.removed).toEqual(["bogus"]);
    // …candidate shows stripped view for display, but cfg is untouched.
    expect(result.state.pendingChanges).toBe(true);
    // Hint tells user to use --force to actually remove.
    expect(result.state.fixHints).toContain(
      'Run "openclaw doctor --fix --force" to remove these keys.',
    );
  });

  it("preserves unknown keys with --fix alone (no --force)", () => {
    const candidateWithCustomKey = { bogus: true } as unknown as OpenClawConfig;
    const result = applyUnknownConfigKeyStep({
      state: {
        cfg: { bogus: true } as unknown as OpenClawConfig,
        candidate: candidateWithCustomKey,
        pendingChanges: false,
        fixHints: [],
      },
      shouldRepair: true,
      shouldForce: false,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.removed).toEqual(["bogus"]);
    // With --fix but no --force, cfg is NOT modified (data preserved).
    expect((result.state.cfg as Record<string, unknown>).bogus).toBe(true);
    // candidate is also kept as-is in repair mode.
    expect((result.state.candidate as Record<string, unknown>).bogus).toBe(true);
  });

  it("strips unknown keys with --fix --force", () => {
    const result = applyUnknownConfigKeyStep({
      state: {
        cfg: {},
        candidate: { bogus: true } as unknown as OpenClawConfig,
        pendingChanges: false,
        fixHints: [],
      },
      shouldRepair: true,
      shouldForce: true,
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(result.removed).toEqual(["bogus"]);
    // With --force, keys are actually stripped.
    expect((result.state.cfg as Record<string, unknown>).bogus).toBeUndefined();
    expect((result.state.candidate as Record<string, unknown>).bogus).toBeUndefined();
    expect(result.state.pendingChanges).toBe(true);
  });
});
