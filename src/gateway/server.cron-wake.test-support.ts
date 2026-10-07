// Deferred v4 wake proof uses the shared Cron fixture and real session/notice owners.
import { assert, expect, test, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as sessionEventHandoff from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as cronSessionRun from "../cron/session-run.js";
import { saveCronStore } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import { peekSystemEvents, prepareAutomationSystemEvents } from "../infra/system-events.js";
import { directCronReq, type DirectCronState } from "./server.cron.test-support.js";

export function installDeferredCronWakeTests(
  createDeferredWakeReceiver: () => Promise<{
    cronState: DirectCronState;
    job: CronJob;
    sessionKey: string;
    creatorKey: string;
  }>,
) {
  test.for([
    "idle",
    "running-at",
    "running-recurring",
    "force-preserved-at",
    "starts-during-admission",
  ] as const)(
    "binds a deferred Hook to the earliest viable occurrence (%s)",
    async (scenario, testContext) => {
      const startedAt = performance.now();
      const elapsed = () => Math.round(performance.now() - startedAt);
      const phases: Array<{ name: string; startedMs: number; completedMs?: number }> = [];
      const phase = (name: string) => phases.push({ name, startedMs: elapsed() });
      const completed = () => {
        const current = phases.at(-1);
        if (current) {
          current.completedMs = elapsed();
        }
      };
      let reported = false;
      const report = () => {
        if (!reported) {
          reported = true;
          console.error(
            "cron-receiver-phases",
            JSON.stringify({ scenario, elapsedMs: elapsed(), phases }),
          );
        }
      };
      testContext.signal.addEventListener("abort", report, { once: true });
      testContext.onTestFailed(report);
      testContext.onTestFinished(() => testContext.signal.removeEventListener("abort", report));
      phase("fixture");
      const { cronState, job, sessionKey } = await createDeferredWakeReceiver();
      completed();
      const now = Date.now();
      const oneShot = scenario !== "idle" && scenario !== "running-recurring";
      phase("update receiver");
      await cronState.cron.update(job.id, {
        schedule: oneShot
          ? {
              kind: "at",
              at: new Date(
                scenario === "force-preserved-at" ? now + 14_400_000 : now - 1,
              ).toISOString(),
            }
          : { kind: "every", everyMs: 14_400_000, anchorMs: now },
        delivery: { mode: "none" },
      });
      completed();
      const alternatives: CronJob[] = [];
      for (const name of ["First stored alternative", "Second stored alternative"]) {
        phase(`add ${name}`);
        alternatives.push(
          await cronState.cron.add({
            name,
            agentId: "main",
            enabled: true,
            schedule: { kind: "at", at: new Date(now + 3_600_000).toISOString() },
            sessionTarget: "main",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "Review pending notices." },
            delivery: { mode: "none" },
          }),
        );
        completed();
      }
      const expectedReceiverId = alternatives.map((entry) => entry.id).toSorted()[0];
      const deferHookWake = cronState.deferHookWake;
      assert(deferHookWake);
      phase("capture target");
      const expectedTarget = await sessionEventHandoff.captureSessionEventTargetForHost(
        "main",
        sessionKey,
      );
      completed();
      const request = {
        text: "Future receiver notice.",
        agentId: "main",
        expectedTarget,
        commitGuard: () => {},
      };
      const entered = createDeferred();
      const release = createDeferred();
      const runner = vi
        .spyOn(cronSessionRun, "runCronSessionTurn")
        .mockImplementationOnce(async (params) => {
          // The scheduler has already activated its receipt and selected this turn's notices.
          expect(params.sessionPreparation?.notices.events).toEqual([]);
          entered.resolve();
          await release.promise;
          params.assertCurrent();
          return {
            status: "ok",
            executionStarted: true,
            delivered: false,
            deliveryAttempted: false,
          };
        });
      let running: ReturnType<typeof cronState.cron.run> | undefined;
      const startRun = async () => {
        phase("start receiver and await runner entry");
        running = cronState.cron.run(
          job.id,
          oneShot && scenario !== "force-preserved-at" ? "due" : "force",
        );
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, running, "Receiver did not start"),
          testContext.signal,
        );
        completed();
      };
      const prepared = createDeferred();
      const resume = createDeferred();
      let restoreTarget: (() => void) | undefined;
      let pending: ReturnType<typeof deferHookWake> | undefined;
      try {
        if (scenario === "starts-during-admission") {
          const prepareTarget = sessionEventHandoff.prepareSessionEventTargetForHost;
          const targetGate = vi
            .spyOn(sessionEventHandoff, "prepareSessionEventTargetForHost")
            .mockImplementationOnce(async (target) => {
              const lease = await prepareTarget(target);
              prepared.resolve();
              await resume.promise;
              return lease;
            });
          restoreTarget = () => targetGate.mockRestore();
          phase("defer wake and await target preparation");
          pending = deferHookWake(request);
          await withinTest(
            awaitGateBeforeSettlement(prepared.promise, pending, "Wake did not prepare its target"),
            testContext.signal,
          );
          completed();
          await startRun();
          resume.resolve();
          phase("await started receiver refusal");
          await expect(pending).rejects.toThrow("Scheduled wake receiver changed during admission");
          completed();
          expect(peekSystemEvents(sessionKey)).toEqual([]);
        } else {
          if (scenario !== "idle") {
            await startRun();
          }
          phase("first deferred wake");
          await expect(deferHookWake(request)).resolves.toEqual({
            ok: true,
            eventOutcome: "queued",
          });
          completed();
          for (const receiver of [job, ...alternatives]) {
            phase(`prepare notices ${receiver.id}`);
            const notices = await prepareAutomationSystemEvents(sessionKey, receiver.id);
            completed();
            try {
              expect(notices.events.map((event) => event.text)).toEqual(
                receiver.id === expectedReceiverId ? [request.text] : [],
              );
              notices.start();
            } finally {
              notices.release();
            }
          }
          for (const receiver of alternatives) {
            phase(`remove alternative ${receiver.id}`);
            await cronState.cron.remove(receiver.id);
            completed();
          }
          phase("second deferred wake");
          const result = await deferHookWake(request);
          completed();
          expect(result).toMatchObject(
            scenario === "running-at" ? { ok: false } : { ok: true, eventOutcome: "queued" },
          );
          phase("prepare remaining notices");
          const remaining = await prepareAutomationSystemEvents(sessionKey, job.id);
          completed();
          try {
            expect(remaining.events.map((event) => event.text)).toEqual(
              scenario === "running-at" ? [] : [request.text],
            );
            remaining.start();
          } finally {
            remaining.release();
          }
        }
      } finally {
        resume.resolve();
        release.resolve();
        phase("join pending wake and receiver run");
        await Promise.allSettled([pending, running]);
        completed();
        restoreTarget?.();
        runner.mockRestore();
      }
      if (running) {
        phase("verify receiver settlement");
        await expect(running).resolves.toMatchObject({ ok: true, ran: true });
        completed();
      }
      if (scenario === "running-at" || scenario === "starts-during-admission") {
        expect(cronState.cron.getJob(job.id)).toBeUndefined();
      }
      expect(peekSystemEvents(sessionKey)).toEqual([]);
    },
  );

  test("keeps a captured Hook notice with its mapped receiver and revalidates queued admission", async (testContext) => {
    const { cronState, sessionKey, creatorKey } = await createDeferredWakeReceiver();
    const receiver = await cronState.cron.add({
      name: "Mapped Hook receiver",
      agentId: "main",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: `session:${creatorKey}`,
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Review mapped notices." },
    });
    const deferHookWake = cronState.deferHookWake;
    assert(deferHookWake);
    const expectedTarget = await sessionEventHandoff.captureSessionEventTargetForHost(
      "main",
      creatorKey,
    );
    const request = {
      text: "Mapped notice.",
      agentId: "main",
      expectedTarget,
      commitGuard: () => {},
    };
    await expect(deferHookWake(request)).resolves.toEqual({ ok: true, eventOutcome: "queued" });
    expect(peekSystemEvents(sessionKey)).toEqual([]);
    const notices = await prepareAutomationSystemEvents(creatorKey, receiver.id);
    try {
      expect(notices.events.map((event) => event.text)).toEqual([request.text]);
      notices.start();
    } finally {
      notices.release();
    }
    const cfg = cronState.getRuntimeConfig();
    setRuntimeConfigSnapshot({
      ...cfg,
      agents: { ...cfg.agents, entries: { ...cfg.agents?.entries, other: {} } },
    });
    await expect(deferHookWake({ ...request, agentId: "other" })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("Captured wake target"),
    });
    expect(peekSystemEvents(creatorKey)).toEqual([]);

    const prepared = createDeferred();
    const resume = createDeferred();
    const prepareTarget = sessionEventHandoff.prepareSessionEventTargetForHost;
    const gate = vi
      .spyOn(sessionEventHandoff, "prepareSessionEventTargetForHost")
      .mockImplementationOnce(async (target) => {
        const lease = await prepareTarget(target);
        prepared.resolve();
        await resume.promise;
        return lease;
      });
    const pending = deferHookWake(request);
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          prepared.promise,
          pending,
          "Hook notice did not prepare its target",
        ),
        testContext.signal,
      );
      await cronState.cron.update(receiver.id, { enabled: false });
      resume.resolve();
      await expect(pending).rejects.toThrow("Scheduled wake receiver changed during admission");
      expect(peekSystemEvents(creatorKey)).toEqual([]);
      expect(peekSystemEvents(sessionKey)).toEqual([]);
    } finally {
      resume.resolve();
      await Promise.allSettled([pending]);
      gate.mockRestore();
    }
  });

  test.each([false, true])(
    "admits a deferred v4 wake to its receiver's captured session (reset=%s)",
    async (reset) => {
      const { cronState, job, sessionKey, creatorKey } = await createDeferredWakeReceiver();
      const response = await directCronReq(cronState, "wake", {
        mode: "next-heartbeat",
        text: "Review this deferred notice.",
      });
      expect(response, JSON.stringify(response.error ?? null)).toMatchObject({
        ok: true,
        payload: { ok: true },
      });
      expect(peekSystemEvents(creatorKey)).toEqual([]);
      const unrelated = await prepareAutomationSystemEvents(sessionKey, "another-job");
      try {
        expect(unrelated.events).toEqual([]);
      } finally {
        unrelated.release();
      }
      if (reset) {
        await replaceSessionEntry(
          { agentId: "main", sessionKey },
          { sessionId: "wake-replacement", updatedAt: 2 },
        );
      }
      const prepared = await prepareAutomationSystemEvents(sessionKey, job.id);
      try {
        expect(prepared.events.map((event) => event.text)).toEqual(
          reset ? [] : ["Review this deferred notice."],
        );
        prepared.start();
        expect(peekSystemEvents(sessionKey)).toEqual([]);
      } finally {
        prepared.release();
      }
    },
  );

  test("refuses an invalid persisted system-event session receiver", async () => {
    const { cronState, job } = await createDeferredWakeReceiver();
    await saveCronStore(cronState.storePath, {
      version: 1,
      jobs: [
        {
          ...job,
          sessionTarget: "session:agent:main:main",
          payload: { kind: "systemEvent", text: "Unsupported persisted receiver." },
        },
      ],
    });
    expect(await cronState.cron.list()).toMatchObject([
      { id: job.id, sessionTarget: "session:agent:main:main" },
    ]);
    const response = await directCronReq(cronState, "wake", {
      mode: "next-heartbeat",
      text: "Must not become an orphaned notice.",
    });
    expect(response).toMatchObject({
      ok: true,
      payload: { ok: false, reason: expect.stringContaining("No enabled ordinary scheduled") },
    });
    expect(peekSystemEvents("agent:main:main")).toEqual([]);
  });

  test.for([
    "requester",
    "receiver",
    "default-owner",
    "roles",
    "scheduler",
    "unrelated-config",
  ] as const)(
    "revalidates a deferred wake when %s changes during target capture",
    async (changed, testContext) => {
      const { cronState, job } = await createDeferredWakeReceiver();
      const captured = createDeferred();
      const resume = createDeferred();
      const capture = sessionEventHandoff.captureSessionEventTargetForHost;
      const gate = vi
        .spyOn(sessionEventHandoff, "captureSessionEventTargetForHost")
        .mockImplementationOnce(async (...args) => {
          const target = await capture(...args);
          captured.resolve();
          await resume.promise;
          return target;
        });
      let requesterCurrent = true;
      const pending = directCronReq(
        cronState,
        "wake",
        { mode: "next-heartbeat", text: "Must not cross revoked admission." },
        {
          sessionMutationCommitGuard: () => {
            if (!requesterCurrent) {
              throw new Error("Wake requester is no longer current");
            }
          },
        },
      );
      try {
        await withinTest(
          awaitGateBeforeSettlement(captured.promise, pending, "Wake did not capture its target"),
          testContext.signal,
        );
        if (changed === "requester") {
          requesterCurrent = false;
        } else if (changed === "receiver") {
          await cronState.cron.update(job.id, { enabled: false });
        } else if (changed === "scheduler") {
          cronState.cron.stop();
        } else if (changed === "roles") {
          const cfg = cronState.getRuntimeConfig();
          setRuntimeConfigSnapshot({
            ...cfg,
            gateway: {
              ...cfg.gateway,
              roles: {
                default: "restricted",
                definitions: {
                  restricted: { agents: [], scopes: [], sessions: { others: "none" } },
                },
              },
            },
          });
        } else if (changed === "unrelated-config") {
          const cfg = cronState.getRuntimeConfig();
          setRuntimeConfigSnapshot({
            ...cfg,
            messages: { ...cfg.messages, responsePrefix: "test" },
          });
        } else {
          const cfg = cronState.getRuntimeConfig();
          setRuntimeConfigSnapshot({
            ...cfg,
            agents: {
              ...cfg.agents,
              defaults: { ...cfg.agents?.defaults, systemAgent: { agentId: "other" } },
              entries: { ...cfg.agents?.entries, other: {} },
            },
          });
        }
        resume.resolve();
        if (changed === "unrelated-config") {
          expect(await pending).toMatchObject({ ok: true, payload: { ok: true } });
          const prepared = await prepareAutomationSystemEvents("agent:main:main", job.id);
          try {
            expect(prepared.events).toHaveLength(1);
            prepared.start();
          } finally {
            prepared.release();
          }
        } else {
          expect(await pending).toMatchObject({ ok: false });
        }
        expect(peekSystemEvents("agent:main:main")).toEqual([]);
        expect(peekSystemEvents("agent:other:main")).toEqual([]);
      } finally {
        resume.resolve();
        await pending;
        gate.mockRestore();
      }
    },
  );
}
