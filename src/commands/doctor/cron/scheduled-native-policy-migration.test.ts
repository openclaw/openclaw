import { describe, expect, it } from "vitest";
import { normalizeStoredCronJobs } from "./store-migration.js";

function job(
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { payload: Record<string, unknown> } {
  return {
    id: "job-1",
    name: "Job one",
    enabled: true,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload,
    ...overrides,
  };
}

describe("scheduled native policy migration", () => {
  it.each([
    [["*"], "inherit"],
    [["read", "write"], "disabled"],
    [[], "disabled"],
  ] as const)("migrates toolsAllow %j to %s", (toolsAllow, mode) => {
    const raw = job({ kind: "agentTurn", message: "run", toolsAllow: [...toolsAllow] });
    const result = normalizeStoredCronJobs([raw]);

    expect(result.issues.migratedScheduledNativePolicy).toBe(1);
    expect(result.issues.migratedScheduledNativePolicyDisabled).toBe(
      mode === "disabled" ? 1 : undefined,
    );
    expect(raw.scheduledNativePolicy).toEqual({ version: 1, mode });
  });

  it("does not infer authority from missing or malformed caps", () => {
    const missing = job({ kind: "agentTurn", message: "run" });
    const malformed = job({ kind: "agentTurn", message: "run", toolsAllow: ["read", 1] });
    const result = normalizeStoredCronJobs([missing, malformed]);

    expect(result.legacyScheduledNativePolicyJobs).toEqual(["Job one", "Job one"]);
    expect(missing.scheduledNativePolicy).toBeUndefined();
    expect(malformed.scheduledNativePolicy).toBeUndefined();
  });

  it("preserves valid policy and reports malformed or inapplicable policy", () => {
    const current = job(
      { kind: "agentTurn", message: "run", toolsAllow: ["read"] },
      { scheduledNativePolicy: { version: 1, mode: "disabled" } },
    );
    const malformed = job(
      { kind: "agentTurn", message: "run", toolsAllow: ["*"] },
      { id: "bad", name: "Bad", scheduledNativePolicy: { version: 2, mode: "inherit" } },
    );
    const inapplicable = job(
      { kind: "systemEvent", text: "run" },
      { id: "event", name: "Event", scheduledNativePolicy: { version: 1, mode: "inherit" } },
    );
    const explicitFinite = job(
      { kind: "agentTurn", message: "run", toolsAllow: ["read"] },
      {
        id: "explicit",
        name: "Explicit finite",
        scheduledNativePolicy: { version: 1, mode: "inherit" },
      },
    );
    const defaultFinite = job(
      {
        kind: "agentTurn",
        message: "run",
        toolsAllow: ["read"],
        toolsAllowIsDefault: true,
      },
      {
        id: "default",
        name: "Default finite",
        scheduledNativePolicy: { version: 1, mode: "inherit" },
      },
    );
    const result = normalizeStoredCronJobs([
      current,
      malformed,
      inapplicable,
      explicitFinite,
      defaultFinite,
    ]);

    expect(result.invalidScheduledNativePolicyJobs).toEqual(["Bad", "Event"]);
    expect(current.scheduledNativePolicy).toEqual({ version: 1, mode: "disabled" });
    expect(explicitFinite.scheduledNativePolicy).toEqual({ version: 1, mode: "disabled" });
    expect(defaultFinite.scheduledNativePolicy).toEqual({ version: 1, mode: "inherit" });
  });

  it("is idempotent after migration", () => {
    const raw = job({ kind: "agentTurn", message: "run", toolsAllow: ["*"] });
    expect(normalizeStoredCronJobs([raw]).mutated).toBe(true);
    const second = normalizeStoredCronJobs([raw]);
    expect(second.issues.migratedScheduledNativePolicy).toBeUndefined();
    expect(second.legacyScheduledNativePolicyJobs).toEqual([]);
    expect(second.invalidScheduledNativePolicyJobs).toEqual([]);
  });
});
