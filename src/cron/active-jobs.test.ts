// Unit coverage for active-job accounting and execution authority.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
  type OperationalRunInstanceRef,
} from "../agents/admitted-run-context.js";
import { resolveMessageActionTurnAuthorization } from "../gateway/message-action-turn-capability.js";
import { importFreshModule } from "../plugin-sdk/test-helpers/import-fresh.js";
import {
  advanceCronActiveJobGeneration,
  bindCronJobAdmittedRun,
  bindCronSelfRemovalCommitGuard,
  captureCronJobMessageActionAuthority,
  clearCronJobActive,
  getActiveCronJobCount,
  isCronActiveJobMarkerCurrent,
  isCronJobActive,
  markCronJobActive,
  noteActiveCronJobMessageActionAuthorityMutation,
  noteActiveCronJobRemoval,
  noteActiveCronJobScheduleMutation,
  noteActiveCronJobTriggerMutation,
  onCronJobInactive,
  resetCronActiveJobs,
} from "./active-jobs.js";
import { prepareCronRunAdmission } from "./run-admission.js";
import { TEST_SCHEDULED_EXECUTION } from "./scheduled-occurrence.test-support.js";

const admissions: ReturnType<typeof prepareAgentRunAdmission>[] = [];
function prepareAdmission(
  runId: string,
  operationalRunInstance = createOperationalRunInstanceRef(runId),
) {
  const admission = prepareAgentRunAdmission({
    cfg: {},
    operationalRunInstance,
    facts: {
      runId,
      agentId: "main",
      ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
    },
  });
  admissions.push(admission);
  return admission;
}

function capture(jobId: string, operationalRunInstance: OperationalRunInstanceRef) {
  return captureCronJobMessageActionAuthority({ jobId, operationalRunInstance });
}

function reload(phase: string) {
  return importFreshModule<typeof import("./active-jobs.js")>(
    import.meta.url,
    `./active-jobs.js?cron-self-removal-${phase}`,
  );
}

afterEach(() => {
  for (const admission of admissions.splice(0)) {
    admission.close();
  }
  resetCronActiveJobs();
});

describe("cron message action authority", () => {
  it.each(["closure", "cancellation"] as const)(
    "keeps a long-running prompt's grant until %s",
    async (end) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const jobId = "long-message-read";
      const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
      const controller = new AbortController();
      const identity = {
        agentId: "main",
        runId: "long-message-run",
        sessionId: "persistent-message-session",
        sessionKey: "cron:long-message-read",
      };
      const owner = prepareCronRunAdmission({
        scheduledExecution: TEST_SCHEDULED_EXECUTION,
        deliveryAttemptFence: { beforeAttempt: async () => {}, assertCurrent: () => {} },
        cfg: { agents: { defaults: { timeoutSeconds: 40 } } },
        ...identity,
        jobId,
        toolsAllow: ["message"],
        scheduledToolPolicy: { version: 1, mode: "trusted" },
      });
      try {
        bindCronJobAdmittedRun(
          marker,
          await owner.preparedRunAdmission.admit("embedded"),
          controller.signal,
        );
        clock.mockReturnValue(now + 120_000);
        const lookup = { token: owner.messageActionTurnCapability, ...identity };
        const grant = expectDefined(
          resolveMessageActionTurnAuthorization(lookup)?.scheduled,
          "live scheduled grant",
        );
        expect(grant.assertCurrent).not.toThrow();
        expect(
          resolveMessageActionTurnAuthorization({ ...lookup, sessionId: lookup.runId }),
        ).toBeUndefined();
        expect(
          resolveMessageActionTurnAuthorization({ ...lookup, runId: "another-invocation" }),
        ).toBeUndefined();
        if (end === "closure") {
          owner.close();
          expect(resolveMessageActionTurnAuthorization(lookup)).toBeUndefined();
        } else {
          controller.abort();
        }
        expect(grant.assertCurrent).toThrow();
      } finally {
        owner.close();
        clock.mockRestore();
      }
    },
  );

  it("keeps pending authority bound to its exact operational admission", async () => {
    const jobId = "pending-message-read";
    const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true });
    const controller = new AbortController();
    const runId = "shared-message-run";
    const expectedInstance = createOperationalRunInstanceRef(runId);
    const expected = prepareAdmission(runId, expectedInstance);
    const other = prepareAdmission(runId);
    const assertCurrent = capture(jobId, expectedInstance);
    expect(assertCurrent).toBeTypeOf("function");
    expect(assertCurrent).toThrow();
    bindCronJobAdmittedRun(marker, await other.admit("embedded"), controller.signal);
    expect(assertCurrent).toThrow();
    bindCronJobAdmittedRun(marker, await expected.admit("embedded"), controller.signal);
    expect(assertCurrent).not.toThrow();
    expected.close();
    expect(assertCurrent).toThrow();
  });

  it.each(["source observation", "committed mutation"] as const)(
    "keeps %s revocation through a new prompt without cancelling the run",
    async (source) => {
      const jobId = "revoked-message-read";
      let sourceCurrent = true;
      const marker = markCronJobActive(jobId, {
        isMessageActionAuthorityCurrent: () => sourceCurrent,
      });
      const controller = new AbortController();
      const first = prepareAdmission("message-run");
      const replacement = prepareAdmission("message-run");
      const admitted = await first.admit("embedded");
      bindCronJobAdmittedRun(marker, admitted, controller.signal);
      const assertCurrent = capture(jobId, admitted.operationalRunInstance);
      expect(assertCurrent).not.toThrow();
      if (source === "committed mutation") {
        noteActiveCronJobMessageActionAuthorityMutation(jobId);
      } else {
        sourceCurrent = false;
      }
      expect(assertCurrent).toThrow();
      expect(resolveAdmittedRunActiveAssertion(admitted, controller.signal)).not.toThrow();
      expect(controller.signal.aborted).toBe(false);
      sourceCurrent = true;
      first.close();
      const next = await replacement.admit("embedded");
      bindCronJobAdmittedRun(marker, next, controller.signal);
      const assertReplacementCurrent = capture(jobId, next.operationalRunInstance);
      expect(assertReplacementCurrent).toBeTypeOf("function");
      expect(assertReplacementCurrent).toThrow();
      expect(getActiveCronJobCount()).toBeGreaterThan(0);
    },
  );
});

it("refuses self-removal without an active run", () => {
  const commitGuard = bindCronSelfRemovalCommitGuard(
    "idle-job",
    createOperationalRunInstanceRef("idle-run"),
    vi.fn(),
    vi.fn(),
  );
  expect(commitGuard).toThrow("Cron self-removal requires the exact live run");
});

describe.each(["same module", "reload before guard", "reload after guard"])(
  "active cron self-removal ownership: %s",
  (moduleBoundary) => {
    it.each([
      "active owner",
      "closed admission",
      "aborted run",
      "closed after validation",
      "aborted after validation",
      "expired caller",
      "replaced marker",
      "replaced admission",
      "retired generation",
      "copied guard",
      "different instance",
    ] as const)("keeps self-removal bound to the %s", async (scenario) => {
      const jobId = "self-removing-job";
      const marker = markCronJobActive(jobId, { isMessageActionAuthorityCurrent: () => true })!;
      const controller = new AbortController();
      const admission = prepareAdmission("self-removal-run");
      const replacement = prepareAdmission("replacement-run");
      const context = await admission.admit("embedded");
      bindCronJobAdmittedRun(marker, context, controller.signal);
      const assertMessageCurrent = capture(jobId, context.operationalRunInstance);
      expect(assertMessageCurrent).not.toThrow();
      let callerActive = true;
      let commitGuard: () => void = vi.fn();
      const bindingModule =
        moduleBoundary === "reload before guard"
          ? await reload("before-guard")
          : { bindCronSelfRemovalCommitGuard };
      commitGuard = bindingModule.bindCronSelfRemovalCommitGuard(
        jobId,
        scenario === "different instance"
          ? createOperationalRunInstanceRef(context.operationalRunInstance.runId)
          : context.operationalRunInstance,
        commitGuard,
        () => {
          if (!callerActive) {
            throw new Error("caller expired");
          }
        },
      );
      let currentMarker = marker;
      if (scenario === "closed admission") {
        admission.close();
      } else if (scenario === "aborted run") {
        controller.abort();
      } else if (scenario === "expired caller") {
        callerActive = false;
      } else if (scenario === "replaced admission") {
        bindCronJobAdmittedRun(marker, await replacement.admit("embedded"), controller.signal);
      } else if (scenario === "replaced marker" || scenario === "retired generation") {
        if (scenario === "retired generation") {
          advanceCronActiveJobGeneration();
        }
        currentMarker = markCronJobActive(jobId)!;
      }
      const cancel = vi.fn();
      currentMarker.cancellation = { kind: "bound", cancel };

      if (
        scenario === "active owner" ||
        scenario === "copied guard" ||
        scenario === "closed after validation" ||
        scenario === "aborted after validation"
      ) {
        expect(commitGuard).not.toThrow();
      } else {
        expect(commitGuard).toThrow();
      }
      expect(cancel).not.toHaveBeenCalled();
      expect(currentMarker.jobRemoved).toBeUndefined();
      if (scenario === "closed after validation") {
        admission.close();
      } else if (scenario === "aborted after validation") {
        controller.abort();
      }
      const removalGuard = scenario === "copied guard" ? () => commitGuard() : commitGuard;
      const removalModule =
        moduleBoundary === "same module"
          ? { noteActiveCronJobRemoval }
          : await reload("after-guard");
      expect(removalModule.noteActiveCronJobRemoval(jobId, removalGuard)).toBe(currentMarker);
      expect(currentMarker).toMatchObject({ jobRemoved: true, scheduleMutated: true });
      expect(assertMessageCurrent).toThrow();
      expect(getActiveCronJobCount()).toBeGreaterThan(0);
      if (scenario === "active owner") {
        expect(cancel).not.toHaveBeenCalled();
      } else {
        expect(cancel).toHaveBeenCalledExactlyOnceWith("Cron job removed by operator.");
      }
    });
  },
);

describe("active cron schedule ownership", () => {
  it.each([false, true])("preserves a replacement marker (restart=%s)", (restart) => {
    const jobId = "manual-reuse";
    const oldMarker = markCronJobActive(jobId);
    if (restart) {
      advanceCronActiveJobGeneration();
    }
    const freshMarker = markCronJobActive(jobId);
    clearCronJobActive(jobId, oldMarker);
    expect(isCronJobActive(jobId)).toBe(true);
    clearCronJobActive(jobId, freshMarker);
    expect(isCronJobActive(jobId)).toBe(false);
  });

  it("retires preserved main-session markers at the lifecycle cutoff", () => {
    const jobId = "manual-main-cutoff";
    const marker = markCronJobActive(jobId, { preserveAcrossGenerationAdvance: true });
    advanceCronActiveJobGeneration();
    expect(isCronActiveJobMarkerCurrent(marker)).toBe(true);
    resetCronActiveJobs();
    expect([isCronActiveJobMarkerCurrent(marker), isCronJobActive(jobId)]).toEqual([false, false]);
  });

  it("notifies only the removed marker when a same-id run replaces it", () => {
    const removedMarker = markCronJobActive("reused-job");
    const onRemovedInactive = vi.fn();
    onCronJobInactive(noteActiveCronJobRemoval("reused-job"), onRemovedInactive);
    const replacementMarker = markCronJobActive("reused-job");

    clearCronJobActive("reused-job", replacementMarker);
    expect(onRemovedInactive).not.toHaveBeenCalled();

    clearCronJobActive("reused-job", removedMarker);
    expect(onRemovedInactive).toHaveBeenCalledOnce();
  });

  it.each([
    ["schedule", noteActiveCronJobScheduleMutation, "scheduleMutated", "jobRemoved"],
    ["trigger", noteActiveCronJobTriggerMutation, "triggerMutated", "scheduleMutated"],
  ] as const)(
    "records %s edits only on the replacement run without changing other ownership",
    (_name, mutate, changed, untouched) => {
      const retired = markCronJobActive("updated-job");
      clearCronJobActive("updated-job", retired);
      const marker = markCronJobActive("updated-job");
      mutate("updated-job");
      expect([marker?.[changed], marker?.[untouched], retired?.[changed]]).toEqual([
        true,
        undefined,
        undefined,
      ]);
    },
  );

  it.each([
    ["removal", noteActiveCronJobRemoval],
    ["trigger", noteActiveCronJobTriggerMutation],
    ["schedule", noteActiveCronJobScheduleMutation],
  ] as const)("does not create idle markers for %s", (_name, mutate) => {
    mutate("idle-job");
    expect(getActiveCronJobCount()).toBe(0);
  });

  it("keeps schedule ownership isolated across concurrent active jobs", () => {
    const markers = Array.from({ length: 64 }, (_, index) =>
      markCronJobActive(`rescheduled-job-${index}`),
    );

    for (let index = 0; index < markers.length; index += 2) {
      noteActiveCronJobScheduleMutation(`rescheduled-job-${index}`);
      noteActiveCronJobScheduleMutation(`rescheduled-job-${index}`);
    }

    for (const [index, marker] of markers.entries()) {
      expect(marker?.scheduleMutated).toBe(index % 2 === 0 ? true : undefined);
    }
  });
});
