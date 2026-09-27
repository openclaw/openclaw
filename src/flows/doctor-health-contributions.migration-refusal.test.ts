import { describe, expect, it, vi } from "vitest";
import type { LegacyStateMigrationStepReceipt } from "../infra/state-migrations.types.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import {
  createDoctorHealthFlowContext,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

function receipt(
  outcome: "refused" | "warning",
  requiredness: "required" | "conditional",
): LegacyStateMigrationStepReceipt {
  return {
    id: "plugin-doctor-post-session-state",
    phase: "final",
    source: [{ kind: "owner", id: "plugin:example:legacy-state" }],
    target: [{ kind: "owner", id: "plugin:example:doctor-state" }],
    requiredness,
    reversibility: "checkpoint-required",
    outcome,
    changes: [],
    warnings: ["Owner could not complete the planned repair"],
    ...(outcome === "refused"
      ? {
          refusal: { code: "step-refused", message: "Owner could not complete the planned repair" },
        }
      : {}),
  };
}

describe("Doctor contribution migration outcomes", () => {
  it.each([
    { requiredness: "required", rehearsal: false },
    { requiredness: "conditional", rehearsal: false },
    { requiredness: "required", rehearsal: true },
    { requiredness: "conditional", rehearsal: true },
  ] as const)(
    "stops after a $requiredness refusal (rehearsal: $rehearsal)",
    async ({ requiredness, rehearsal }) => {
      const recorded = receipt("refused", requiredness);
      const receipts: LegacyStateMigrationStepReceipt[] = [];
      const ctx = createDoctorHealthFlowContext({
        configResult: { stateMigrationStepReceipts: receipts },
        ...(rehearsal
          ? {
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
            }
          : {}),
      });
      const later = vi.fn(async () => {});
      await expect(
        runDoctorHealthContributionList(ctx, [
          createDoctorHealthContribution({
            id: "doctor:session-transcripts",
            label: "Sessions",
            run: async () => {
              receipts.push(recorded);
            },
          }),
          createDoctorHealthContribution({ id: "doctor:later", label: "Later repair", run: later }),
        ]),
      ).rejects.toMatchObject({ stepReceipts: [recorded] });
      expect(later).not.toHaveBeenCalled();
      expect(receipts).toEqual([recorded]);
    },
  );

  it("continues after an owner-classified recoverable warning and an unrelated advisory throw", async () => {
    const recorded = receipt("warning", "conditional");
    const receipts: LegacyStateMigrationStepReceipt[] = [];
    const ctx = createDoctorHealthFlowContext({
      configResult: { stateMigrationStepReceipts: receipts },
    });
    const later = vi.fn(async () => {});
    await runDoctorHealthContributionList(ctx, [
      createDoctorHealthContribution({
        id: "doctor:session-transcripts",
        label: "Sessions",
        run: async () => {
          receipts.push(recorded);
        },
      }),
      createDoctorHealthContribution({
        id: "doctor:advisory",
        label: "Advisory",
        run: async () => {
          throw new Error("optional diagnostic unavailable");
        },
      }),
      createDoctorHealthContribution({ id: "doctor:later", label: "Later repair", run: later }),
    ]);
    expect(later).toHaveBeenCalledOnce();
    expect(receipts).toEqual([recorded]);
  });
});
