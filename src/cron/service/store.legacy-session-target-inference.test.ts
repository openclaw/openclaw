// Regression test: legacy cron jobs without sessionTarget should survive
// hot-reload by inferring the default from payload.kind, instead of being
// silently quarantined.
// Fixes https://github.com/openclaw/openclaw/issues/93895
import { describe, expect, it } from "vitest";
import { normalizeCronJobInput } from "../normalize.js";
import { inferSessionTargetFromPayload } from "./store.js";

describe("cron store: legacy sessionTarget inference on load", () => {
  it("normalizeCronJobInput strips sessionTarget for agentTurn job without explicit target (baseline)", () => {
    // This confirms the current behavior: without sessionTarget, normalize
    // does not infer it from payload.kind — the field is absent from output.
    // The store load path then sees getInvalidPersistedCronJobReason return
    // null (it doesn't check sessionTarget), so the job passes validation
    // but has no sessionTarget, which later causes assertSupportedJobSpec to
    // throw during scheduling.
    const legacyJob = {
      id: "legacy-agent-turn",
      name: "Daily Summary",
      schedule: { kind: "cron" as const, expr: "0 9 * * *" },
      payload: { kind: "agentTurn" as const, message: "summarize" },
      agentId: "main",
    };
    const result = normalizeCronJobInput(legacyJob);
    // Result is non-null but sessionTarget is undefined — the field is not inferred.
    expect(result).not.toBeNull();
    expect(result!.sessionTarget).toBeUndefined();
  });

  it("normalizeCronJobInput succeeds when sessionTarget is explicitly set", () => {
    const job = {
      id: "with-target",
      name: "Daily Summary",
      schedule: { kind: "cron" as const, expr: "0 9 * * *" },
      payload: { kind: "agentTurn" as const, message: "summarize" },
      sessionTarget: "isolated",
      agentId: "main",
    };
    const result = normalizeCronJobInput(job);
    expect(result).not.toBeNull();
    expect(result!.sessionTarget).toBe("isolated");
  });

  it("normalizeCronJobInput succeeds for systemEvent with explicit sessionTarget='main'", () => {
    const job = {
      id: "heartbeat",
      name: "Heartbeat",
      schedule: { kind: "cron" as const, expr: "*/30 * * * *" },
      payload: { kind: "systemEvent" as const, text: "HEARTBEAT" },
      sessionTarget: "main",
    };
    const result = normalizeCronJobInput(job);
    expect(result).not.toBeNull();
    expect(result!.sessionTarget).toBe("main");
  });

  it("inferSessionTargetFromPayload defaults agentTurn to 'isolated'", () => {
    expect(inferSessionTargetFromPayload({ kind: "agentTurn", message: "hi" })).toBe("isolated");
    expect(inferSessionTargetFromPayload({ kind: "command", argv: ["run"] })).toBe("isolated");
    expect(inferSessionTargetFromPayload({ kind: "systemEvent", text: "ping" })).toBe("main");
    expect(inferSessionTargetFromPayload({ kind: "unknown" })).toBeNull();
    expect(inferSessionTargetFromPayload(null)).toBeNull();
  });
});
