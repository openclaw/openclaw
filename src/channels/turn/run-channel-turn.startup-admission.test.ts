import { expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { withPluginServiceScheduler } from "../../plugins/service-scheduler-binding.js";
import { createPluginServiceScheduler } from "../../plugins/service-scheduler.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  assertAgentDatabaseAdmitted,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../../state/agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "../../state/agent-database-startup.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { OpenClawDatabaseSchemaPreflight } from "../../state/openclaw-database-preflight.types.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runPreparedChannelTurn } from "./execution.js";

it.for(["admitted", "failed", "account-stopped", "gateway-stopped"] as const)(
  "keeps replay behind its agent startup admission: %s",
  async (outcome, { signal }) => {
    await withOpenClawTestState({ label: "channel-turn-startup-admission" }, async (state) => {
      await withAgentDatabaseStartupAdmission(async (admission) => {
        const inspections = new Map(
          ["qa", "other"].map((agentId) => [
            agentId,
            createDeferredCore<OpenClawDatabaseSchemaPreflight>(),
          ]),
        );
        const refusals = admission.defer({
          env: state.env,
          inspections: [...inspections].map(([agentId, inspection]) => ({
            target: {
              agentId,
              path: openOpenClawAgentDatabase({ agentId, env: state.env }).path,
            },
            result: inspection.promise,
          })),
          reason: "Gateway startup is preparing the agent",
        });
        recordAgentDatabaseAdmissions(refusals, { env: state.env, source: "startup" });
        const lifetime = admission.adopt();
        admission.activate({
          isCurrent: () => true,
          preparationReady: Promise.resolve(),
          openAgent: async () => {},
          migrateAgent: async () => {},
          publishAgent: async () => {},
        });
        const clock = createGatewaySchedulerClock(0);
        const gateway = createTestGatewayScheduler(clock.clock);
        const { scheduler } = createPluginServiceScheduler(gateway);
        const record = vi.fn(async () => assertAgentDatabaseAdmitted("qa", { env: state.env }));
        const dispatch = vi.fn(async () => ({
          queuedFinal: true,
          counts: { tool: 0, block: 0, final: 1 },
        }));
        const preDispatchFailure = vi.fn();
        const sessionKey = "agent:qa:qa-channel:direct:peer";
        const turn = withPluginServiceScheduler(scheduler, () =>
          runPreparedChannelTurn({
            channel: "qa-channel",
            routeSessionKey: sessionKey,
            storePath: state.statePath("agents", "qa", "sessions", "sessions.json"),
            ctxPayload: finalizeInboundContext({
              AgentId: "qa",
              SessionKey: sessionKey,
              Body: "replayed inbound",
              Provider: "qa-channel",
            }),
            recordInboundSession: record,
            runDispatch: dispatch,
            onPreDispatchFailure: preDispatchFailure,
          }),
        );
        void turn.catch(() => {});
        try {
          expect(record).not.toHaveBeenCalled();
          expect(dispatch).not.toHaveBeenCalled();
          if (outcome === "admitted") {
            inspections.get("qa")!.resolve({ incompatible: [], indeterminate: [] });
            expect((await withinTest(turn, signal)).dispatched).toBe(true);
            expect(record).toHaveBeenCalledOnce();
            expect(dispatch).toHaveBeenCalledOnce();
            expect(readAgentDatabaseAdmissionRefusal("other", { env: state.env })?.code).toBe(
              "agent-database-inspection-pending",
            );
          } else if (outcome === "failed") {
            inspections.get("qa")!.reject(new Error("inspection failed"));
            await expect(withinTest(turn, signal)).rejects.toThrow("inspection failed");
            expect(dispatch).not.toHaveBeenCalled();
            expect(preDispatchFailure).toHaveBeenCalledOnce();
          } else {
            const stopping = outcome === "account-stopped" ? scheduler.stop() : lifetime.stop();
            await expect(withinTest(turn, signal)).rejects.toBeInstanceOf(Error);
            expect(record).not.toHaveBeenCalled();
            expect(dispatch).not.toHaveBeenCalled();
            expect(preDispatchFailure).toHaveBeenCalledOnce();
            for (const inspection of inspections.values()) {
              inspection.resolve({ incompatible: [], indeterminate: [] });
            }
            await stopping;
          }
        } finally {
          for (const inspection of inspections.values()) {
            inspection.resolve({ incompatible: [], indeterminate: [] });
          }
          await Promise.allSettled([turn, lifetime.stop(), scheduler.stop(), gateway.stop()]);
        }
      });
    });
  },
);
