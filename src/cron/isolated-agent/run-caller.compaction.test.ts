import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { acceptCompactionSuccessor } from "../../agents/embedded-agent-runner/compaction-successor.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { admitScheduledOccurrence } from "../execution-context-admission.js";
import { cronTestJob } from "../service.fixture-builders.test-support.js";
import { prepareCronCaller } from "./run-caller.js";
import { resolveCronSourceDeliveryPlan } from "./source-delivery-plan.js";

it("admits a WhatsApp occurrence against the committed compaction successor", async () => {
  await withOpenClawTestState(
    { label: "personal-cron-successor", scenario: "minimal" },
    async (state) => {
      const agentId = "main";
      const accountId = "default";
      const senderId = "+15550000001";
      const sessionKey = `agent:${agentId}:whatsapp:${accountId}:direct:${senderId}`;
      const sessionId = "predecessor";
      const storePath = path.join(state.agentDir(), "openclaw-agent.sqlite");
      const cfg = { session: { store: storePath } };
      const target = { agentId, sessionKey, sessionId, storePath };
      const entry = { sessionId, lifecycleRevision: "revision", updatedAt: 1 };
      await replaceSessionEntry(target, entry);
      const payload = {
        kind: "agentTurn" as const,
        message: "Read my orders",
        toolsAllow: ["qa_my_orders"],
      };
      const job = {
        ...cronTestJob({ id: "personal", agentId, delivery: { mode: "none" } }),
        payload,
        owner: { agentId, accountId, sessionKey },
        sourceConversation: { sessionKey, sessionId },
        scheduledToolPolicy: {
          version: 1 as const,
          mode: "account" as const,
          ownerSessionKey: sessionKey,
          ownerAccountId: accountId,
        },
        toolsAllowProvenance: {
          version: 1 as const,
          source: "final-executable-surface" as const,
          callerOrigin: { kind: "external" as const, channel: "whatsapp" },
        },
      };
      const successor = await acceptCompactionSuccessor({
        config: cfg,
        currentTarget: target,
        expectedEntry: { ...entry, activeWriterRunId: undefined },
        assertActive() {},
        result: {
          ok: true,
          compacted: true,
          result: { sessionId: "successor", tokensBefore: 512 },
        },
      });
      expect(successor.entry.sessionId).toBe("successor");
      const occurrence = await admitScheduledOccurrence({ cfg, job, agentId, trigger: "cron" });
      const minted = occurrence.mint({
        cfg,
        agentId,
        runId: "due",
        runSessionKey: "agent:main:cron:personal:run:due",
      });
      try {
        expect(minted.result).toMatchObject({
          status: "ready",
          facts: { principal: { kind: "parent", parent: { sessionKey, sessionId: "successor" } } },
        });
        const resolvedDelivery = {
          ok: false as const,
          mode: "implicit" as const,
          error: new Error("Gateway owns delivery"),
        };
        const { personal } = prepareCronCaller({
          occurrence: {
            ...occurrence,
            personalRequester: { accountId, senderId, tools: [], assertCurrent() {} },
          },
          job,
          agentPayload: payload,
          operatorAuthority: undefined,
          cfgWithAgentDefaults: cfg,
          resolvedDelivery,
          sourceDelivery: resolveCronSourceDeliveryPlan({
            deliveryPlan: resolveCronDeliveryPlan(job),
            resolvedDelivery,
          }),
        });
        const caller = expectDefined(personal, "personal occurrence");
        caller.requireParent(minted);
        caller.assertCurrent();
      } finally {
        minted.release();
        occurrence.release();
      }
    },
  );
});
