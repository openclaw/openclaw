import { expect, it, vi } from "vitest";
import { runWithAgentToolExecutionContext } from "../../../packages/agent-core/src/tool-execution-context.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { progressCardStore } from "../../gateway/progress-card-store.js";
import { createDirectChatContext } from "../../gateway/server-chat.agent-events.test-helpers.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { WorkSnapshot } from "../../session-cards/progress-card-work-intent.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { captureProgressWorkReader } from "../embedded-agent-runner/run/progress-work.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { captureProgressWorkWait } from "./progress-work-wait.js";

// Consumer-boundary controls complement the real native-producer outer tests.
// These receipts are host fixtures, not claims of media-provider acceptance.
it("fences retained receipts by original admission and exact physical requester", async () => {
  await withOpenClawTestState(
    { label: "retained-receipt-custody", scenario: "minimal" },
    async (state) => {
      const originalStore = state.path("original.sqlite");
      const config = { agents: { entries: { main: {} } }, session: { store: originalStore } };
      setRuntimeConfigSnapshot(config);
      let currentConfig = config;
      const gateway = createDirectChatContext({ getRuntimeConfig: () => currentConfig });
      for (const mode of [
        "current",
        "missing",
        "foreign-session",
        "foreign-store",
        "foreign-environment",
        "source-revoked",
        "instance-reused",
        "config-switch",
        "config-switch-during-write",
      ] as const) {
        currentConfig = config;
        setRuntimeConfigSnapshot(config);
        const target = captureSessionTranscriptTargetBinding({
          agentId: "main",
          sessionKey: "agent:main:receipt-" + mode,
          sessionId: "incarnation",
          storePath: originalStore,
        });
        await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
        const reader = captureProgressWorkReader({ target, assertCurrent() {} });
        const source = {
          runId: "original",
          turnId: "saved-turn",
          toolCallId: "saved-plan",
          processGeneration: getAgentRunLifecycleGeneration(),
        };
        await progressCardStore.put(
          target.sessionKey,
          {
            steps: [
              { step: "Already published", status: "completed" },
              { step: "Verify and land", status: "pending" },
            ],
            workCommand: {
              kind: "begin",
              owner: reader.owner,
              source,
              expected: null,
              scope: "Finish landing",
            },
          },
          "main",
        );
        let work: WorkSnapshot = await reader.read();
        const original = structuredClone(work);
        let sourceActive = true;
        const admission = prepareSystemAgentRunAdmission(
          config,
          "same-run-id",
          "main",
          "receipt-test",
          () => {
            if (!sourceActive) {
              throw new Error("Original requester revoked");
            }
          },
        );
        const replacement = prepareSystemAgentRunAdmission(
          config,
          "same-run-id",
          "main",
          "receipt-test",
        );
        try {
          const admitted = await admission.admit("embedded");
          const identity = createAdmittedGatewayToolCallerIdentity({
            admittedRunContext: admitted,
            agentId: "main",
            sessionKey: target.sessionKey,
          });
          if (!identity) {
            throw new Error("Missing native caller");
          }
          const saved = vi.fn((next: WorkSnapshot) => {
            work = next;
          });
          const toolCall = {
            type: "toolCall" as const,
            id: "accepted-media",
            name: "image_generate",
            arguments: { prompt: "fixture" },
          };
          const sink = await withGatewayToolCallerIdentity(
            { ...identity, progressWork: { owner: reader.owner, target, read: () => work, saved } },
            () =>
              runWithAgentToolExecutionContext(
                {
                  assistantMessage: makeAgentAssistantMessage({
                    turnId: "native-turn",
                    content: [toolCall],
                  }),
                  toolCall,
                },
                () => captureProgressWorkWait(),
              ),
          );
          expect(sink).toBeTypeOf("function");
          if (!sink) {
            throw new Error("No retained receipt sink");
          }
          const requester =
            mode === "missing"
              ? undefined
              : {
                  ...target,
                  lifecycleRevision: null,
                  ...(mode === "foreign-session" ? { sessionId: "foreign-incarnation" } : {}),
                  ...(mode === "foreign-store" ? { storePath: state.path("other.sqlite") } : {}),
                  ...(mode === "foreign-environment"
                    ? { env: { OPENCLAW_STATE_DIR: state.path("other-state") } }
                    : {}),
                };
          let destination: ReturnType<typeof captureProgressWorkReader> | undefined;
          let switchDuringWrite: { mockRestore(): void } | undefined;
          if (mode.startsWith("config-switch")) {
            const switched = { ...config, session: { store: state.path("switched.sqlite") } };
            currentConfig = switched;
            setRuntimeConfigSnapshot(switched);
            const other = { ...target, storePath: switched.session.store };
            await upsertSessionEntryCore(other, { sessionId: target.sessionId, updatedAt: 1 });
            destination = captureProgressWorkReader({ target: other, assertCurrent() {} });
            await progressCardStore.put(
              target.sessionKey,
              {
                steps: original.kind === "retained" ? original.state.record!.steps : [],
                workCommand: {
                  kind: "begin",
                  owner: reader.owner,
                  source,
                  expected: null,
                  scope: "Finish landing",
                },
              },
              "main",
            );
          }
          if (mode === "config-switch-during-write") {
            const switched = currentConfig;
            currentConfig = config;
            setRuntimeConfigSnapshot(config);
            const put = progressCardStore.put.bind(progressCardStore);
            switchDuringWrite = vi
              .spyOn(progressCardStore, "put")
              .mockImplementation(async (...args) => {
                currentConfig = switched;
                setRuntimeConfigSnapshot(switched);
                return put(...args);
              });
          }
          const destinationBefore = await destination?.read();
          if (mode === "source-revoked") {
            sourceActive = false;
          }
          const invoke = () =>
            withPluginRuntimeGatewayRequestScope(
              { context: gateway, isWebchatConnect: () => false },
              () => sink({ kind: "media", runId: "media-run", taskId: "media-task" }, requester),
            );
          if (mode === "instance-reused") {
            admission.close();
            const next = await replacement.admit("embedded");
            expect(next.operationalRunInstance.runId).toBe(admitted.operationalRunInstance.runId);
            expect(next.operationalRunInstance.instanceId).not.toBe(
              admitted.operationalRunInstance.instanceId,
            );
            await withGatewayToolCallerIdentity(
              createAdmittedGatewayToolCallerIdentity({
                admittedRunContext: next,
                agentId: "main",
                sessionKey: target.sessionKey,
              }),
              invoke,
            );
          } else {
            try {
              await invoke();
            } finally {
              switchDuringWrite?.mockRestore();
            }
          }
          const actual = await reader.read();
          if (destination) {
            expect(await destination.read()).toEqual(destinationBefore);
          }
          if (mode === "current") {
            expect(saved).toHaveBeenCalledOnce();
            expect(actual).toMatchObject({
              kind: "retained",
              state: {
                revision: 2,
                record: {
                  disposition: {
                    kind: "waiting",
                    receipt: { taskId: "media-task" },
                    source: {
                      runId: "same-run-id",
                      turnId: "native-turn",
                      toolCallId: "accepted-media",
                    },
                  },
                },
              },
            });
          } else {
            if (mode.startsWith("config-switch")) {
              expect(saved).toHaveBeenCalledOnce();
              expect(work).toMatchObject({ coverage: { kind: "unavailable" } });
            } else {
              expect(saved, mode).not.toHaveBeenCalled();
            }
            expect(actual, mode).toEqual(original);
          }
        } finally {
          admission.close();
          replacement.close();
        }
      }
    },
  );
});
