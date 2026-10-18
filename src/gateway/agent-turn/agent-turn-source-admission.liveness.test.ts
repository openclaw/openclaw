import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { isClaimedByLiveRequesterTurn } from "../../agents/subagents/registry/subagent-requester-turn-liveness.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { registerChatAbortController } from "../chat-abort.js";
import { prepareAgentSession } from "../server-methods/agent-session-prepare.js";
import { prepareAgentRequestPreflight } from "./agent-request-preflight.js";
import { createAgentTurnTestContext } from "./agent-run-dispatch.test-support.js";
import {
  registerAgentTurnRunAbort,
  registerAgentTurnSourceAdmission,
} from "./agent-turn-source-admission.js";

it.each([
  { layout: "default", admission: "early" },
  { layout: "custom", admission: "early" },
  { layout: "default", admission: "prepared" },
] as const)(
  "keeps private children with the native requester through $layout storage and $admission admission",
  async ({ layout, admission }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const agentId = "beta";
      const sessionKey = "agent:beta:requester";
      const sessionId = "native-requester-session";
      const runId = "native-requester-turn";
      const logicalStore =
        layout === "custom"
          ? state.path("custom", "sessions.json")
          : path.join(state.sessionsDir(agentId), "sessions.json");
      const physicalStore =
        layout === "custom"
          ? state.path("custom", "openclaw-agent.beta.sqlite")
          : state.statePath("agents", agentId, "agent", "openclaw-agent.sqlite");
      const cfg: OpenClawConfig = {
        agents: { entries: { alpha: {}, beta: {} } },
        ...(layout === "custom" ? { session: { store: logicalStore } } : {}),
      };
      setRuntimeConfigSnapshot(cfg);
      await replaceSessionEntry(
        { agentId, sessionKey, storePath: logicalStore },
        { sessionId, updatedAt: 1 },
      );
      const context = createAgentTurnTestContext();
      context.getRuntimeConfig = () => cfg;
      const io = { emitAcceptance: vi.fn(), emitFinal: vi.fn() };
      const preflight = expectDefined(
        await prepareAgentRequestPreflight({
          request: {
            message: admission === "prepared" ? "/reset" : "Continue the task",
            sessionKey,
            idempotencyKey: runId,
          },
          context,
          client: null,
          io,
        }),
        "native requester preflight",
      );
      const sourceWork = createDeferred();
      const registrations: ReturnType<typeof registerChatAbortController>[] = [];
      const sourceOptions = {
        preflight,
        io,
        sourceWork: sourceWork.promise,
        lifecycleGeneration: getAgentRunLifecycleGeneration(),
        isSourcePreparationComplete: () => true,
        onCancelled: vi.fn(),
        onRegistered: (registration: ReturnType<typeof registerChatAbortController>) =>
          registrations.push(registration),
      };
      await registerAgentTurnSourceAdmission({
        ...sourceOptions,
        principal: null,
        sessionKey,
        agentId,
        assertRequestCurrent: () => {},
      });
      if (admission === "prepared") {
        expect(registrations).toHaveLength(0);
        const prepared = expectDefined(
          await prepareAgentSession({
            cfg,
            requestedSessionKey: sessionKey,
            requestedSessionId: sessionId,
            expectedExistingSessionId: sessionId,
            agentId,
            request: preflight.request,
            canUseCronRunContinuation: false,
            lifecycleGeneration: getAgentRunLifecycleGeneration(),
            respond: vi.fn(),
          }),
          "prepared requester session",
        );
        registerAgentTurnRunAbort(sourceOptions, {
          cfg: prepared.cfg,
          storeScope: prepared.storePath,
          physicalStorePath: prepared.physicalStorePath,
          sessionKey: prepared.canonicalKey,
          agentId: prepared.canonicalSessionAgentId,
          sessionId: prepared.sessionId,
          incarnation: prepared.entry?.sessionId,
        });
      }
      const registration = expectDefined(registrations[0], "native requester admission");
      const source = expectDefined(registration.entry, "native requester source");
      const child = createSubagentRunRecord({
        runId: "private-child",
        childSessionKey: "agent:beta:subagent:private-child",
        requesterSessionKey: sessionKey,
        requesterAgentId: agentId,
        requesterStorePath: physicalStore,
        requesterTurnRunId: runId,
        expectsCompletionMessage: true,
      });
      const turn = { sessionKey, sessionId, agentId, storePath: logicalStore };
      try {
        expect(io.emitAcceptance).not.toHaveBeenCalled();
        await withSessionTurn({ ...turn, controllerInput: source.input }, async (operation) => {
          const requester = expectDefined(operation, "native requester operation");
          expect(isClaimedByLiveRequesterTurn(child)).toBe(true);
          await withSessionTurn({ ...turn, replyOperation: requester }, async () => {
            expect(isClaimedByLiveRequesterTurn(child)).toBe(true);
            expect(
              isClaimedByLiveRequesterTurn({
                ...child,
                requesterStorePath: physicalStore + ".other",
              }),
            ).toBe(false);
            requester.yield();
            expect(isClaimedByLiveRequesterTurn(child)).toBe(true);
          });
        });
        expect(isClaimedByLiveRequesterTurn(child)).toBe(false);
      } finally {
        sourceWork.resolve();
        registration.cleanup();
        await source.input.settlement.promise;
      }
    });
  },
);
