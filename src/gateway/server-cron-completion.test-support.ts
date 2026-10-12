import { expect, it, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { sendCronAnnouncePayloadStrict } from "../cron/delivery.js";
import type { CronEvent } from "../cron/service.js";
import type { CronServiceState } from "../cron/service/state.js";
import type { GatewayCronServiceContract } from "./server-cron-contract.js";

export function registerGatewayCronCompletionTests<T extends { cron: GatewayCronServiceContract }>({
  createCronConfig,
  createCronService,
  getCronDeps,
  loadConfigMock,
  sendCronAnnouncePayloadStrictMock,
  cronScriptExecutorMock,
}: {
  createCronConfig: (name: string) => OpenClawConfig;
  createCronService: (cfg: OpenClawConfig) => T;
  getCronDeps: (service: T) => Pick<CronServiceState["deps"], "onEvent">;
  loadConfigMock: Mock;
  sendCronAnnouncePayloadStrictMock: Mock<typeof sendCronAnnouncePayloadStrict>;
  cronScriptExecutorMock: Mock;
}) {
  it.each(["command", "script"] as const)(
    "preserves %s diagnostics when cross-agent delivery warns and the one-shot completes",
    async (kind) => {
      const cfg = createCronConfig(`server-cron-${kind}-announcement-complete`);
      cfg.agents = { entries: { main: {}, other: {} } };
      cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
      cfg.bindings = [
        {
          agentId: "other",
          match: { channel: "telegram", peer: { kind: "direct", id: "123" } },
        },
      ];
      loadConfigMock.mockReturnValue(cfg);
      if (kind === "script") {
        cronScriptExecutorMock.mockResolvedValueOnce({
          kind: "completed",
          notify: "scheduled result",
          stateChanged: false,
        });
      }
      const state = createCronService(cfg);
      const finishedEvents: CronEvent[] = [];
      const deps = getCronDeps(state);
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

        expect(sendCronAnnouncePayloadStrictMock).toHaveBeenCalledOnce();
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
                message:
                  "Conversation context skipped: the destination belongs to a different agent.",
              }),
            ]),
          },
        });
      } finally {
        state.cron.stop();
      }
    },
  );
}
