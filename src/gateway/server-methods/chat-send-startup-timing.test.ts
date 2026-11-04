import { performance } from "node:perf_hooks";
import { expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as dispatch from "../../auto-reply/dispatch.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { loadOrCreateProcessDeviceIdentityAsync } from "../../infra/device-identity-async.js";
import {
  areDiagnosticsEnabledForProcess,
  onTrustedInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import * as agentDispatch from "./chat-send-agent-dispatch.js";
import { handleChatSend } from "./chat-send-handler.js";
import * as workspace from "./session-create-project.js";

test.each(["admission_wait", "workspace_readiness"] as const)(
  "attributes accepted dispatch %s without charging model execution",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await loadOrCreateProcessDeviceIdentityAsync();
      const sessionKey = "agent:main:startup-timing";
      const sessionId = "startup-timing-session";
      const runId = "startup-timing-run";
      setRuntimeConfigSnapshot({ agents: { defaults: { workspace: state.workspaceDir } } });
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        { sessionId, updatedAt: Date.now(), status: "done" },
      );
      const entered = createDeferred();
      const release = createDeferred();
      const modelStarted = createDeferred();
      const modelDone = createDeferred();
      const finished = createDeferred();
      const events: DiagnosticEventPayload[] = [];
      const previous = areDiagnosticsEnabledForProcess();
      setDiagnosticsEnabledForProcess(true);
      const stop = onTrustedInternalDiagnosticEvent((event) => events.push(event), {
        include: ["diagnostic.phase.completed"],
      });
      let clock = 0;
      const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
      const runDispatch = agentDispatch.startChatDispatch;
      const dispatchSpy = vi
        .spyOn(agentDispatch, "startChatDispatch")
        .mockImplementation((params) => {
          if (phase === "workspace_readiness") {
            params.session.entry = {
              ...params.session.entry!,
              pendingProjectGitUrl: "https://example.com/synthetic.git",
            };
          } else {
            const admission = params.admission.gatewayWorkAdmission;
            params.admission.gatewayWorkAdmission = {
              ...admission,
              run: async (operation) => {
                entered.resolve();
                await release.promise;
                return admission.run(operation);
              },
            };
          }
          return runDispatch(params);
        });
      const workspaceSpy = vi.spyOn(workspace, "prepareSessionWorkspace").mockReturnValue({
        sessionKey,
        assertCurrent: () => {},
        promptReady: Promise.resolve(),
        isReady: () => false,
        getFailure: () => undefined,
        waitUntilReady: async () => {
          entered.resolve();
          await release.promise;
        },
      });
      const model = vi
        .spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher")
        .mockImplementation(async () => {
          modelStarted.resolve();
          await modelDone.promise;
          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        });
      try {
        const context = createDirectChatContext({
          recordClientActivity: () => {
            clock += 1_000;
          },
          removeChatRun: () => {
            finished.resolve();
            return undefined;
          },
        });
        const respond = vi.fn();
        await handleChatSend({
          context,
          client: null,
          isWebchatConnect: () => false,
          respond,
          req: { type: "req", id: runId, method: "chat.send" },
          params: { sessionKey, message: "synthetic startup timing input", idempotencyKey: runId },
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ runId, status: "started" }),
          undefined,
          expect.anything(),
        );
        if (phase === "admission_wait") {
          await entered.promise;
          clock += 2_500;
          release.resolve();
        }
        await modelStarted.promise;
        clock += 6_000;
        modelDone.resolve();
        if (phase === "workspace_readiness") {
          await entered.promise;
          clock += 2_500;
          release.resolve();
        }
        await finished.promise;
        await waitForDiagnosticEventsDrained();
        const spans = events.filter(
          (event) =>
            event.type === "diagnostic.phase.completed" &&
            event.name === "chat.send.detail.dispatch." + phase,
        );
        expect(spans).toEqual([
          expect.objectContaining({
            durationMs: 2_500,
            details: { stage: "startup", sessionId, runId },
          }),
        ]);
        expect(
          events.filter(
            (event) =>
              event.type === "diagnostic.phase.completed" &&
              event.name === "chat.send.detail.dispatch.accepted_handoff",
          ),
        ).toEqual([
          expect.objectContaining({
            durationMs: 1_000,
            details: { stage: "startup", sessionId, runId },
          }),
        ]);
        expect(model).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        modelDone.resolve();
        dispatchSpy.mockRestore();
        workspaceSpy.mockRestore();
        model.mockRestore();
        now.mockRestore();
        stop();
        setDiagnosticsEnabledForProcess(previous);
      }
    });
  },
);
