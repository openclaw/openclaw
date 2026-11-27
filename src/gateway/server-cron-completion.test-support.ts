import { expect, it, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { sendCronAnnouncePayloadStrict } from "../cron/delivery.js";
import type { CronEvent } from "../cron/service.js";
import type { CronServiceState } from "../cron/service/state.js";
import type { CronJobCreate } from "../cron/types.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";

export function registerGatewayCronCompletionTests<
  T extends { cron: GatewayCronServiceContract },
>(h: {
  createCronConfig: (name: string) => OpenClawConfig;
  createTriggerConfig: (name: string) => OpenClawConfig;
  withCronService: (cfg: OpenClawConfig, run: (service: T) => Promise<void>) => Promise<void>;
  addScriptJob: (
    service: T,
    name: string,
    script: string,
    overrides: Partial<Omit<CronJobCreate, "name" | "payload">>,
  ) => ReturnType<GatewayCronServiceContract["add"]>;
  enqueueSystemEventMock: Mock;
  createCronService: (cfg: OpenClawConfig) => T;
  getCronDeps: (service: T) => Pick<CronServiceState["deps"], "onEvent">;
  loadConfigMock: Mock;
  sendCronAnnouncePayloadStrictMock: Mock<typeof sendCronAnnouncePayloadStrict>;
  cronScriptExecutorMock: Mock;
}) {
  it.each(["command", "script"] as const)(
    "preserves %s diagnostics when destination history warns and the one-shot completes",
    async (kind) => {
      const cfg = h.createCronConfig(`server-cron-${kind}-announcement-complete`);
      cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
      h.loadConfigMock.mockReturnValue(cfg);
      const transcriptWarning =
        "Conversation context skipped: the destination belongs to a different agent.";
      h.sendCronAnnouncePayloadStrictMock.mockImplementationOnce(async (params) => {
        params.onTranscriptDiagnostic?.(transcriptWarning);
        return {
          status: "sent",
          payloads: Array.isArray(params.payload) ? params.payload : [params.payload],
        };
      });
      if (kind === "script") {
        h.cronScriptExecutorMock.mockResolvedValueOnce({
          kind: "completed",
          notify: "scheduled result",
          stateChanged: false,
        });
      }
      const state = h.createCronService(cfg);
      const finishedEvents: CronEvent[] = [];
      const deps = h.getCronDeps(state);
      const onEvent = deps.onEvent;
      deps.onEvent = (event, context) => {
        if (event.action === "finished") {
          finishedEvents.push(event);
        }
        onEvent?.(event, context);
      };
      try {
        const job = await state.cron.add({
          name: `${kind} announcement`,
          agentId: "main",
          enabled: true,
          schedule: { kind: "at", at: new Date(Date.now() - 1_000).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload:
            kind === "command"
              ? {
                  kind: "command",
                  argv: [process.execPath, "-e", "process.stdout.write('scheduled result')"],
                }
              : { kind: "script", script: "return { notify: 'scheduled result' };" },
          deleteAfterRun: true,
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        });

        await state.cron.run(job.id, "due");

        expect(h.sendCronAnnouncePayloadStrictMock).toHaveBeenCalledOnce();
        expect(state.cron.getJob(job.id)).toBeUndefined();
        const finished = finishedEvents.find((event) => event.jobId === job.id);
        expect(finished).toMatchObject({
          status: "ok",
          completionStatus: "succeeded",
          deliveryStatus: "delivered",
          diagnostics: {
            entries: expect.arrayContaining([
              ...(kind === "command"
                ? [expect.objectContaining({ source: "exec", severity: "info" })]
                : []),
              expect.objectContaining({
                source: "delivery",
                severity: "warn",
                message: transcriptWarning,
              }),
            ]),
          },
        });
      } finally {
        state.cron.stop();
      }
    },
  );

  it.each([
    { notify: "queue changed", expected: "queue changed" },
    { notify: "NO_REPLY", expected: undefined },
    { notify: "NO_REPLY\nNO_REPLY", expected: "NO_REPLY" },
    { notify: "NO_REPLY.", expected: "NO_REPLY." },
  ])(
    "prepares isolated script notify $notify before announcement",
    async ({ notify, expected }) => {
      const cfg = h.createTriggerConfig("server-cron-script-announce");
      cfg.gateway = {
        publicOrigin: "https://gateway.example",
        controlUi: { basePath: "/control" },
      };

      h.cronScriptExecutorMock.mockResolvedValueOnce({
        kind: "completed",
        notify,
        stateChanged: false,
      });

      await h.withCronService(cfg, async (state) => {
        const job = await h.addScriptJob(
          state,
          "script-announce",
          "return { notify: 'queue changed' }",
          {
            deleteAfterRun: false,
            delivery: { mode: "announce", channel: "telegram", to: "123", threadId: 456 },
          },
        );

        await state.cron.run(job.id, "force");

        expect(h.cronScriptExecutorMock).toHaveBeenCalledWith(
          expect.objectContaining({
            job: expect.objectContaining({
              id: job.id,
              payload: expect.objectContaining({
                script: "return { notify: 'queue changed' }",
                timeoutSeconds: 300,
                toolBudget: 50,
              }),
            }),
          }),
        );
        if (expected === undefined) {
          expect(h.sendCronAnnouncePayloadStrictMock).not.toHaveBeenCalled();
          expect(state.cron.getJob(job.id)?.state.deliverySuppressionReason).toBe("silent");
        } else {
          expect(h.sendCronAnnouncePayloadStrictMock).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              jobId: job.id,
              payload: [{ text: expected }],
              inspectionUrl: `https://gateway.example/control/automations?job=${job.id}&run=cron%3A${job.id}%3A${state.cron.getJob(job.id)?.state.lastRunAtMs}`,
              target: expect.objectContaining({ threadId: 456 }),
            }),
          );
          expect(state.cron.getJob(job.id)?.state.deliverySuppressionReason).toBeUndefined();
        }
        expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
      });
    },
  );

  it("announces selected-conversation script output once", async () => {
    const cfg = h.createTriggerConfig("server-cron-selected-script-announce");
    h.cronScriptExecutorMock.mockResolvedValueOnce({
      kind: "completed",
      notify: "Ready",
      stateChanged: false,
    });

    await h.withCronService(cfg, async (state) => {
      const job = await h.addScriptJob(state, "script-announce", "return { notify: 'Ready' }", {
        sessionTarget: "session:agent:main:reports",
        deleteAfterRun: false,
        delivery: { mode: "announce", channel: "telegram", to: "123", threadId: 456 },
      });

      await state.cron.run(job.id, "force");

      expect(h.sendCronAnnouncePayloadStrictMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          jobId: job.id,
          payload: [{ text: "Ready" }],
          target: expect.objectContaining({ channel: "telegram", to: "123", threadId: 456 }),
        }),
      );
      expect(h.enqueueSystemEventMock).not.toHaveBeenCalled();
    });
  });

  it("keeps script output in the selected conversation when no announcement destination is set", async () => {
    const cfg = h.createTriggerConfig("server-cron-selected-script-notice");
    h.cronScriptExecutorMock.mockResolvedValueOnce({
      kind: "completed",
      notify: "Ready",
      stateChanged: false,
    });

    await h.withCronService(cfg, async (state) => {
      const job = await h.addScriptJob(state, "script-notice", "return { notify: 'Ready' }", {
        sessionTarget: "session:agent:main:reports",
      });

      await state.cron.run(job.id, "force");

      expect(h.enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith(
        "Ready",
        expect.objectContaining({ sessionKey: "agent:main:reports" }),
      );
      expect(h.sendCronAnnouncePayloadStrictMock).not.toHaveBeenCalled();
    });
  });
}
