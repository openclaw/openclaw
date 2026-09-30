// Unit coverage for the active-job accounting the heartbeat busy guard depends on.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
import { resolveMessageActionTurnAuthorization } from "../gateway/message-action-turn-capability.js";
import { importFreshModule } from "../plugin-sdk/test-helpers/import-fresh.js";
import {
  advanceCronActiveJobGeneration,
  bindCronJobAdmittedRun,
  bindCronSelfRemovalCommitGuard,
  captureCronJobMessageActionAuthority,
  clearCronJobActive,
  hasActiveCronJobs,
  hasActiveCronJobsExceptMarkers,
  markCronJobActive,
  noteActiveCronJobMessageActionAuthorityMutation,
  noteActiveCronJobRemoval,
  noteActiveCronJobScheduleMutation,
  noteActiveCronJobTriggerMutation,
  onCronJobInactive,
  resetCronActiveJobs,
} from "./active-jobs.js";
import { prepareCronPromptRunAdmission } from "./isolated-agent/run-admission.js";

afterEach(() => {
  resetCronActiveJobs();
});

describe("hasActiveCronJobsExceptMarkers", () => {
  it("discounts only the named job's own marker", () => {
    const marker = markCronJobActive("nightly-report");

    expect(hasActiveCronJobs()).toBe(true);
    expect(hasActiveCronJobsExceptMarkers([marker!])).toBe(false);
  });

  it("still reports busy while an unrelated job is active", () => {
    const marker = markCronJobActive("nightly-report");
    markCronJobActive("different-job");

    // The owning job must not be waved through while another run holds a marker:
    // Cron executes jobs up to the built-in concurrency limit.
    expect(hasActiveCronJobsExceptMarkers([marker!])).toBe(true);
  });

  it("discounts every exact coalesced owner", () => {
    const first = markCronJobActive("first-report");
    const second = markCronJobActive("second-report");

    expect(hasActiveCronJobsExceptMarkers([first!, second!])).toBe(false);
  });

  it("reports idle once the unrelated job clears", () => {
    const marker = markCronJobActive("nightly-report");
    const otherMarker = markCronJobActive("different-job");
    clearCronJobActive("different-job", otherMarker);

    expect(hasActiveCronJobsExceptMarkers([marker!])).toBe(false);
  });

  it("does not discount a replacement marker with the same job id", () => {
    const staleMarker = markCronJobActive("nightly-report");
    const replacementMarker = markCronJobActive("nightly-report");

    expect(hasActiveCronJobsExceptMarkers([staleMarker!])).toBe(true);
    expect(hasActiveCronJobsExceptMarkers([replacementMarker!])).toBe(false);
  });
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
      const owner = prepareCronPromptRunAdmission({
        cfg: { agents: { defaults: { timeoutSeconds: 40 } } },
        agentId: "main",
        runId: "long-message-run",
        sessionId: "persistent-message-session",
        sessionKey: "cron:long-message-read",
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
        const lookup = {
          token: owner.messageActionTurnCapability,
          agentId: "main",
          runId: "long-message-run",
          sessionKey: "cron:long-message-read",
          sessionId: "persistent-message-session",
        };
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
    const prepare = (operationalRunInstance = createOperationalRunInstanceRef(runId)) =>
      prepareAgentRunAdmission({
        cfg: {},
        operationalRunInstance,
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
        },
      });
    const expected = prepare(expectedInstance);
    const other = prepare();
    const assertCurrent = captureCronJobMessageActionAuthority({
      jobId,
      operationalRunInstance: expectedInstance,
    });
    expect(assertCurrent).toBeTypeOf("function");
    try {
      expect(assertCurrent).toThrow();
      bindCronJobAdmittedRun(marker, await other.admit("embedded"), controller.signal);
      expect(assertCurrent).toThrow();
      bindCronJobAdmittedRun(marker, await expected.admit("embedded"), controller.signal);
      expect(assertCurrent).not.toThrow();
      expected.close();
      expect(assertCurrent).toThrow();
    } finally {
      expected.close();
      other.close();
    }
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
      const prepare = () =>
        prepareAgentRunAdmission({
          cfg: {},
          operationalRunInstance: createOperationalRunInstanceRef("message-run"),
          facts: {
            runId: "message-run",
            agentId: "main",
            ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
          },
        });
      const first = prepare();
      const replacement = prepare();
      try {
        const admitted = await first.admit("embedded");
        bindCronJobAdmittedRun(marker, admitted, controller.signal);
        const assertCurrent = captureCronJobMessageActionAuthority({
          jobId,
          operationalRunInstance: admitted.operationalRunInstance,
        });
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
        const assertReplacementCurrent = captureCronJobMessageActionAuthority({
          jobId,
          operationalRunInstance: next.operationalRunInstance,
        });
        expect(assertReplacementCurrent).toBeTypeOf("function");
        expect(assertReplacementCurrent).toThrow();
        expect(hasActiveCronJobs()).toBe(true);
      } finally {
        first.close();
        replacement.close();
      }
    },
  );
});

describe.each(["same module", "reload before guard", "reload after guard"])(
  "active cron self-removal ownership: %s",
  (moduleBoundary) => {
    it.each([
      "active owner",
      "closed admission",
      "aborted run",
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
      const admission = prepareAgentRunAdmission({
        cfg: {},
        operationalRunInstance: createOperationalRunInstanceRef("self-removal-run"),
        facts: {
          runId: "self-removal-run",
          agentId: "main",
          ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
        },
      });
      const replacement = prepareAgentRunAdmission({
        cfg: {},
        operationalRunInstance: createOperationalRunInstanceRef("replacement-run"),
        facts: {
          runId: "replacement-run",
          agentId: "main",
          ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
        },
      });
      try {
        const context = await admission.admit("embedded");
        bindCronJobAdmittedRun(marker, context, controller.signal);
        const assertMessageCurrent = captureCronJobMessageActionAuthority({
          jobId,
          operationalRunInstance: context.operationalRunInstance,
        });
        expect(assertMessageCurrent).not.toThrow();
        let callerActive = true;
        const commitGuard = vi.fn();
        const bindingModule =
          moduleBoundary === "reload before guard"
            ? await importFreshModule<typeof import("./active-jobs.js")>(
                import.meta.url,
                "./active-jobs.js?cron-self-removal-before-guard",
              )
            : { bindCronSelfRemovalCommitGuard };
        bindingModule.bindCronSelfRemovalCommitGuard(
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

        const removalGuard = scenario === "copied guard" ? () => commitGuard() : commitGuard;
        const removalModule =
          moduleBoundary === "same module"
            ? { noteActiveCronJobRemoval }
            : await importFreshModule<typeof import("./active-jobs.js")>(
                import.meta.url,
                "./active-jobs.js?cron-self-removal-after-guard",
              );
        expect(removalModule.noteActiveCronJobRemoval(jobId, removalGuard)).toBe(currentMarker);
        expect(currentMarker.jobRemoved).toBe(true);
        expect(assertMessageCurrent).toThrow();
        expect(hasActiveCronJobs()).toBe(true);
        if (scenario === "active owner") {
          expect(cancel).not.toHaveBeenCalled();
        } else {
          expect(cancel).toHaveBeenCalledExactlyOnceWith("Cron job removed by operator.");
        }
      } finally {
        admission.close();
        replacement.close();
      }
    });
  },
);

describe("active cron schedule ownership", () => {
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

  it("records durable job removal without releasing the active run marker", () => {
    const marker = markCronJobActive("removed-job");

    noteActiveCronJobRemoval("removed-job");

    expect(marker?.scheduleMutated).toBe(true);
    expect(marker?.jobRemoved).toBe(true);
    expect(marker?.cancellation).toEqual({
      kind: "requested",
      reason: "Cron job removed by operator.",
    });
    expect(hasActiveCronJobs()).toBe(true);
  });

  it("does not mistake an ordinary schedule edit for job removal", () => {
    const marker = markCronJobActive("updated-job");

    noteActiveCronJobScheduleMutation("updated-job");

    expect(marker?.scheduleMutated).toBe(true);
    expect(marker?.jobRemoved).toBeUndefined();
  });

  it("does not create active markers when removing an idle job", () => {
    noteActiveCronJobRemoval("idle-removed-job");

    expect(hasActiveCronJobs()).toBe(false);
  });

  it("records trigger mutations without retiring schedule ownership", () => {
    const marker = markCronJobActive("trigger-edited-job");

    noteActiveCronJobTriggerMutation("trigger-edited-job");

    expect(marker?.triggerMutated).toBe(true);
    expect(marker?.scheduleMutated).toBeUndefined();
  });

  it("does not create trigger markers for an idle job", () => {
    noteActiveCronJobTriggerMutation("idle-trigger-job");

    expect(hasActiveCronJobs()).toBe(false);
  });

  it("attributes later edits only to the replacement active run", () => {
    const retiredMarker = markCronJobActive("rescheduled-job");
    clearCronJobActive("rescheduled-job", retiredMarker);
    const replacementMarker = markCronJobActive("rescheduled-job");

    noteActiveCronJobScheduleMutation("rescheduled-job");

    expect(retiredMarker?.scheduleMutated).toBeUndefined();
    expect(replacementMarker?.scheduleMutated).toBe(true);
  });

  it("does not create ownership markers for jobs without an active run", () => {
    noteActiveCronJobScheduleMutation("idle-job");

    expect(hasActiveCronJobs()).toBe(false);
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
