import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { CronJobCreate } from "../cron/types.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import type { buildGatewayCronService } from "./server-cron.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { drainSessionEventPublications } from "./session-event-prepared-row.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";

type CronFixture = ReturnType<typeof buildGatewayCronService>;
type GatewayCronSessionProjectionTestHarness = {
  createCronService: (
    cfg: OpenClawConfig,
    overrides?: Partial<
      Pick<Parameters<typeof buildGatewayCronService>[0], "broadcast" | "resolveGatewayContext">
    >,
  ) => CronFixture;
  addAgentTurnJob: (
    service: CronFixture,
    name: string,
    message: string,
    overrides?: Partial<Omit<CronJobCreate, "name" | "payload">>,
  ) => ReturnType<CronFixture["cron"]["add"]>;
  loadConfigMock: { mockReturnValue: (cfg: OpenClawConfig) => unknown };
};

export function registerGatewayCronSessionProjectionTests({
  createCronService,
  addAgentTurnJob,
  loadConfigMock,
}: GatewayCronSessionProjectionTestHarness) {
  it("delivers refreshed rows for cold sessions when cron bindings change", async () => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_SKIP_CRON: "0" } },
      async () => {
        const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
        loadConfigMock.mockReturnValue(cfg);
        for (let index = 0; index <= 100; index++) {
          replaceSessionEntrySync(
            { agentId: "main", sessionKey: `agent:main:binding-${index}` },
            { sessionId: `binding-${index}`, updatedAt: index + 1 },
          );
        }
        const release = retainSessionListForegroundWork();
        const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
        const connection = createGatewayConnectionState({
          scheduler: createTestGatewayScheduler(),
          bootId: "cron-binding-broadcast",
          cfg,
        });
        const detach = connection.attachSessionRowProjection(projection);
        const { client, socket } = makeClient("cron-observer", "operator", ["operator.admin"]);
        connection.clients.add(client);
        const context = {
          resolveGatewayContext: (): GatewayRequestContext => context,
        } as GatewayRequestContext;
        bindSessionRowProjection(context, connection.getSessionRowProjection);
        const state = createCronService(cfg, {
          broadcast: connection.broadcast,
          resolveGatewayContext: () => context,
        });
        try {
          await state.cron.start();
          await projection.ensureMaterialized();
          const cold = expectDefined(
            projection.selectEntries().find((row) => !row.materialized),
            "evicted session row",
          );
          const query = { agentId: "main", key: cold.key };
          expect(projection.describe(query)).toBeUndefined();
          socket.send.mockClear();
          const job = await addAgentTurnJob(state, "bound schedule", "ping", {
            schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
            sessionTarget: `session:${cold.key}`,
          });
          await projection.ensureMaterialized();
          await drainSessionEventPublications(projection);
          const sessionsChanged = () =>
            socket.send.mock.calls
              .map(([frame]) => JSON.parse(String(frame)))
              .filter((frame) => frame.event === "sessions.changed")
              .map((frame) => frame.payload);
          expect(sessionsChanged()).toEqual([
            expect.objectContaining({
              sessionKey: cold.key,
              reason: "cron-binding",
              session: expect.objectContaining({
                sessionId: cold.entry.sessionId,
                hasAutomation: true,
              }),
            }),
          ]);

          socket.send.mockClear();
          await state.cron.update(job.id, { enabled: false });
          await drainSessionEventPublications(projection);
          const disabled = sessionsChanged();
          expect(disabled).toEqual([
            expect.objectContaining({
              sessionKey: cold.key,
              reason: "cron-binding",
              session: expect.objectContaining({
                sessionId: cold.entry.sessionId,
              }),
            }),
          ]);
          expect(disabled[0].session).not.toHaveProperty("hasAutomation");
        } finally {
          state.cron.stop();
          await drainSessionEventPublications(projection);
          detach();
          await connection.mentionInbox.dispose();
          projection.dispose();
          release();
        }
      },
    );
  });
}
