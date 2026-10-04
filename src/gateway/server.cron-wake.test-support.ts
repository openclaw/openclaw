// Deferred v4 wake proof uses the shared Cron fixture and real session/notice owners.
import { expect, test, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as sessionEventHandoff from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
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
