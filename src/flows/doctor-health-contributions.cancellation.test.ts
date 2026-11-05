import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import type { LegacyStateMigrationStepReceipt } from "../infra/state-migrations.types.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { runSessionTranscriptsHealth } from "./doctor-health-contribution-runners.state.js";
import {
  createDoctorHealthContribution,
  showDoctorHealthSummary,
} from "./doctor-health-contribution.js";
import { runDoctorHealthContributions } from "./doctor-health-contributions.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";

it.each([false, true])(
  "stops admitting Doctor checks after cancellation (optional check throws: %s)",
  async (throws) => {
    const work = new AsyncWorkScope();
    const reason = new DOMException("CLI stopping (SIGTERM)", "AbortError");
    const later = vi.fn(async () => {});
    const cleaned = vi.fn();
    const ctx = createDoctorHealthFlowContext({ env: {} });
    await expect(
      work.track(() =>
        runDoctorHealthContributionList(ctx, [
          createDoctorHealthContribution(
            "doctor:interrupted",
            "Interrupted inspection",
            async () => {
              try {
                work.beginClose(reason);
                if (throws) {
                  throw new Error("Optional inspection failed during shutdown");
                }
              } finally {
                await Promise.resolve();
                cleaned();
              }
            },
          ),
          createDoctorHealthContribution("doctor:later", "Later inspection", later),
        ]),
      ),
    ).rejects.toBe(reason);
    await work.drain();
    expect(cleaned).toHaveBeenCalledOnce();
    expect(later).not.toHaveBeenCalled();
  },
);

afterEach(() => vi.restoreAllMocks());

describe("Doctor contribution migration outcomes", () => {
  function receipt(outcome: "refused" | "warning"): LegacyStateMigrationStepReceipt {
    return {
      id: "plugin-doctor-post-session-state",
      phase: "final",
      source: [{ kind: "owner", id: "plugin:example:legacy-state" }],
      target: [{ kind: "owner", id: "plugin:example:doctor-state" }],
      requiredness: "conditional",
      reversibility: "checkpoint-required",
      outcome,
      changes: [],
      warnings: ["Owner could not complete the planned repair"],
      ...(outcome === "refused"
        ? {
            refusal: {
              code: "step-refused",
              message: "Owner could not complete the planned repair",
            },
          }
        : {}),
    };
  }

  it("stops copied-state rehearsal after a conditional migration refusal", async () => {
    const recorded = receipt("refused");
    const receipts: LegacyStateMigrationStepReceipt[] = [];
    const ctx = createDoctorHealthFlowContext({
      configResult: { stateMigrationStepReceipts: receipts },

      env: {
        ...buildUpdateRehearsalPathEnv("/synthetic/rehearsal"),
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_SERVICE_REPAIR_POLICY: "external",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
        OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
      },
      updateBudget: {
        agentCount: 1,
        phase: "validation" as const,
        inspectionDeadlineMs: Date.now() + 149_000,
        source: "validation-ledger" as const,
        deferred: new Map(),
      },
    });
    const later = vi.fn(async () => {});
    await expect(
      runDoctorHealthContributionList(ctx, [
        createDoctorHealthContribution("doctor:session-transcripts", "Sessions", async () => {
          receipts.push(recorded);
        }),
        createDoctorHealthContribution("doctor:later", "Later repair", later),
      ]),
    ).rejects.toMatchObject({ stepReceipts: [recorded] });
    expect(later).not.toHaveBeenCalled();
    expect(receipts).toEqual([recorded]);
  });

  it("continues after an owner-classified recoverable warning and an unrelated advisory throw", async () => {
    const recorded = receipt("warning");
    const receipts: LegacyStateMigrationStepReceipt[] = [];
    const ctx = createDoctorHealthFlowContext({
      configResult: { stateMigrationStepReceipts: receipts },
    });
    const later = vi.fn(async () => {});
    await runDoctorHealthContributionList(ctx, [
      createDoctorHealthContribution("doctor:session-transcripts", "Sessions", async () => {
        receipts.push(recorded);
      }),
      createDoctorHealthContribution("doctor:advisory", "Advisory", async () => {
        throw new Error("optional diagnostic\nunavailable");
      }),
      createDoctorHealthContribution("doctor:later", "Later repair", later),
    ]);
    expect(later).toHaveBeenCalledOnce();
    expect(receipts).toEqual([recorded]);
    showDoctorHealthSummary(ctx);
    expect(ctx.runtime.log).toHaveBeenCalledWith(
      "- Doctor could not complete Advisory: optional diagnostic unavailable",
    );
  });
});

it("stops after an optional contribution fails after writing config", async () => {
  const laterRun = vi.fn(async () => undefined);
  const ctx = createDoctorHealthFlowContext({ env: {} });
  const failure = new ConfigWritePostCommitError({
    configPath: ctx.configPath,
    rollbackStatus: "not-restored",
    cause: new Error("config path changed since last load"),
  });

  await expect(
    runDoctorHealthContributionList(ctx, [
      createDoctorHealthContribution("doctor:test-config-write", "Test config write", async () => {
        throw failure;
      }),
      createDoctorHealthContribution("doctor:test-later", "Test later", laterRun),
    ]),
  ).rejects.toBe(failure);

  expect(laterRun).not.toHaveBeenCalled();
});

it.each([
  ["release-configured-plugin-installs", "plugin-registry"],
  ["plugin-registry", "write-config"],
  ["plugin-registry", "runtime-tool-schemas"],
  ["legacy-state", "session-transcripts"],
  ["session-transcripts", "agent-memory-schema"],
  ["session-transcripts", "plugin-registry"],
])("orders Doctor %s before %s", (before, after) => {
  const ids = resolveDoctorHealthContributions().map((entry) => entry.id);
  const earlier = ids.indexOf(`doctor:${before}`);
  const later = ids.indexOf(`doctor:${after}`);
  expect(earlier).toBeGreaterThan(-1);
  expect(later).toBeGreaterThan(-1);
  expect(earlier).toBeLessThan(later);
});

it.each(["completed", "deferred", "warning", "refused", "finding", "diagnostic"] as const)(
  "retains session repair and honors its %s receipt before later repairs",
  async (outcome) => {
    const events: string[] = [];
    const receipt: LegacyStateMigrationStepReceipt = {
      id: "plugin-doctor-post-session-state",
      phase: "final" as const,
      source: [],
      target: [],
      requiredness: "conditional" as const,
      reversibility: "checkpoint-required" as const,
      outcome: outcome === "finding" || outcome === "diagnostic" ? "completed" : outcome,
      changes: outcome === "completed" ? ["Repaired session"] : [],
      warnings: outcome === "warning" ? ["Incomplete session repair"] : [],
      ...(outcome === "refused"
        ? { refusal: { code: "step-refused", message: "Session repair refused" } }
        : {}),
    };
    vi.spyOn(
      await import("../commands/doctor-session-transcripts.js"),
      "noteSessionTranscriptHealth",
    ).mockImplementation(async (options) => {
      events.push("sessions");
      options?.onStepReceipt?.(receipt);
      if (outcome === "finding") {
        options?.onFindings?.([
          { checkId: "example/session", severity: "warning", message: "Session needs attention" },
        ]);
      } else if (outcome === "diagnostic") {
        options?.onWarnings?.(["Session needs attention"]);
      }
      return receipt;
    });
    vi.spyOn(
      await import("./doctor-health-contributions-initial.js"),
      "resolveInitialDoctorHealthContributions",
    ).mockReturnValue([
      createDoctorHealthContribution(
        "doctor:session-transcripts",
        "Sessions",
        runSessionTranscriptsHealth,
      ),
      createDoctorHealthContribution("doctor:unrelated", "Unrelated", async () => {
        events.push("full");
      }),
    ]);
    vi.spyOn(
      await import("./doctor-health-contributions-final.js"),
      "resolveFinalDoctorHealthContributions",
    ).mockReturnValue([
      createDoctorHealthContribution("doctor:write-config", "Write", async () => {
        events.push("write");
      }),
    ]);
    const ctx = createDoctorHealthFlowContext({
      retirementOnly: true,
      prompter: createDoctorPrompterFixture(true),
      env: {},
      configResult: { retirementOnly: true, postSessionPluginMigrationPlanBound: true },
    });

    if (outcome === "refused") {
      await expect(runDoctorHealthContributions(ctx)).rejects.toMatchObject({
        stepReceipts: [receipt],
      });
      expect(events).toEqual(["sessions"]);
    } else {
      await runDoctorHealthContributions(ctx);
      expect(events).toEqual(
        outcome === "completed" ? ["sessions", "write"] : ["sessions", "sessions", "full", "write"],
      );
      expect(ctx.retirementOnly).toBe(outcome === "completed");
    }
    expect(ctx.configResult.stateMigrationStepReceipts?.[0]).toBe(receipt);
  },
);
