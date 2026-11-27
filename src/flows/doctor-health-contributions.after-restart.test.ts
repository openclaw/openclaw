import { expect, it } from "vitest";
import type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";
import {
  createDoctorHealthContribution,
  renderStructuredHealthFindings,
} from "./doctor-health-contribution.js";
import { runDoctorAfterRestartContributions } from "./doctor-health-contributions.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";

// Under Doctor's own stop, contributions placed after the restart are held back while the
// stopped pass runs, then run in their original order with the same failure reporting.

function recordingList(calls: string[]) {
  const writer = (id: string, effect?: (ctx: DoctorHealthFlowContext) => void) =>
    createDoctorHealthContribution(`doctor:${id}`, id, async (ctx) => {
      calls.push(id);
      effect?.(ctx);
    });
  const diagnostic = (id: string, run?: () => Promise<void>) =>
    createDoctorHealthContribution(`doctor:${id}`, id, {
      pending: "diagnostic-only",
      placement: "after-restart",
      run:
        run ??
        (async (ctx) => {
          calls.push(id);
          renderStructuredHealthFindings(ctx, [
            { checkId: `core/doctor/${id}`, severity: "warning", message: `${id} finding` },
          ]);
        }),
    });
  return { writer, diagnostic };
}

function stoppedContext(): DoctorHealthFlowContext {
  return createDoctorHealthFlowContext({
    env: {},
    // Without repair options a refusal reports no legacy state, so no store is read here.
    options: { nonInteractive: true },
    prompter: createDoctorPrompterFixture(true),
    gatewayMaintenanceActive: true,
    afterRestartContributions: [],
  });
}

it("holds placed diagnostics during the stopped pass and runs them afterwards in order", async () => {
  const calls: string[] = [];
  const { writer, diagnostic } = recordingList(calls);
  const ctx = stoppedContext();

  await runDoctorHealthContributionList(ctx, [
    diagnostic("first-diagnostic"),
    writer("repair"),
    diagnostic("second-diagnostic"),
  ]);
  expect(calls).toEqual(["repair"]);
  expect(ctx.healthFindings ?? []).toEqual([]);

  await runDoctorAfterRestartContributions(ctx);
  expect(calls).toEqual(["repair", "first-diagnostic", "second-diagnostic"]);
  expect(ctx.healthFindings?.map((finding) => finding.message)).toEqual([
    "first-diagnostic finding",
    "second-diagnostic finding",
  ]);
  expect(ctx.afterRestartContributions).toBeUndefined();

  await runDoctorAfterRestartContributions(ctx);
  expect(calls).toHaveLength(3);
});

it("runs placed diagnostics in place without Doctor's own stop", async () => {
  const calls: string[] = [];
  const { writer, diagnostic } = recordingList(calls);
  const ctx = createDoctorHealthFlowContext({ env: {} });

  await runDoctorHealthContributionList(ctx, [diagnostic("diagnostic"), writer("repair")]);

  expect(calls).toEqual(["diagnostic", "repair"]);
});

it("defers only the diagnostics a refused pass reached, and runs them without refusal handling", async () => {
  const calls: string[] = [];
  const { writer, diagnostic } = recordingList(calls);
  const ctx = stoppedContext();

  await runDoctorHealthContributionList(ctx, [
    diagnostic("before-refusal"),
    writer("refusing-write", (current) => {
      current.configWriteRefusal = "validation";
    }),
    diagnostic("after-refusal"),
    writer("later-repair"),
  ]);
  expect(calls).toEqual(["refusing-write"]);
  expect(ctx.afterRestartContributions?.map(({ id }) => id)).toEqual(["doctor:before-refusal"]);

  await runDoctorAfterRestartContributions(ctx);
  expect(calls).toEqual(["refusing-write", "before-refusal"]);
});

it("reports a placed diagnostic that throws as it would inside the stop", async () => {
  const calls: string[] = [];
  const { diagnostic } = recordingList(calls);
  const ctx = stoppedContext();

  await runDoctorHealthContributionList(ctx, [
    diagnostic("broken", async () => {
      throw new Error("inspection exploded");
    }),
    diagnostic("healthy"),
  ]);
  await runDoctorAfterRestartContributions(ctx);

  expect(calls).toEqual(["healthy"]);
  expect(ctx.healthFindings?.map(({ checkId, message }) => ({ checkId, message }))).toEqual([
    {
      checkId: "doctor:broken",
      message: "Doctor could not complete broken: inspection exploded",
    },
    { checkId: "core/doctor/healthy", message: "healthy finding" },
  ]);
  expect(ctx.updateWarnings).toEqual(["doctor:broken run failed: inspection exploded"]);
});
