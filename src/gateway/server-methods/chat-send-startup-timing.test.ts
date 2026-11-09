import { performance } from "node:perf_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, test, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { AgentHarnessPreflightError } from "../../agents/harness/errors.js";
import { toSandboxProvisioningError } from "../../agents/sandbox/provisioning-error.js";
import * as dispatch from "../../auto-reply/dispatch.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
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
import { WorkspaceResultLimitError } from "../worker-environments/workspace-inventory-limits.js";
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

test.each([
  {
    name: "storage contention",
    failure: new Error(
      "Managed worktree disk reservation cleanup failed; capacity release is unconfirmed",
      {
        cause: Object.assign(new Error("database is locked"), {
          code: "ERR_SQLITE_ERROR",
          errcode: 5,
        }),
      },
    ),
    notice: "The request was interrupted because OpenClaw storage is busy.",
    diagnostic: undefined,
  },
  {
    name: "storage capacity",
    failure: Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }),
    notice: "OpenClaw couldn't save your conversation because the disk is full.",
    diagnostic: undefined,
  },
  {
    name: "concise public preflight",
    failure: new AgentHarnessPreflightError("private preparation diagnostic", {
      userMessage:
        "This workspace is unavailable. Ask the operator to review its setup before retrying.",
    }),
    notice: "This workspace is unavailable.",
    diagnostic:
      "This workspace is unavailable. Ask the operator to review its setup before retrying.",
  },
  {
    name: "wrapped workspace limit",
    failure: toSandboxProvisioningError(
      new WorkspaceResultLimitError("Private workspace /private/project exceeds its byte limit."),
      "test-backend",
    ),
    notice: "This workspace exceeds OpenClaw's file or size limits.",
    diagnostic: undefined,
  },
  {
    name: "serialized workspace limit",
    failure: toSandboxProvisioningError(
      Object.assign(new Error("Private workspace /private/project has too many entries."), {
        code: "WORKSPACE_RESULT_LIMIT",
      }),
      "test-backend",
    ),
    notice: "This workspace exceeds OpenClaw's file or size limits.",
    diagnostic: undefined,
  },
  {
    name: "unknown private failure",
    failure: new Error(
      "private credentials /private/worktree database is locked WORKSPACE_RESULT_LIMIT",
    ),
    notice: undefined,
    diagnostic:
      "Error: private credentials /private/worktree database is locked WORKSPACE_RESULT_LIMIT",
  },
])("preserves $name through accepted chat.send", async ({ failure, notice, diagnostic }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await loadOrCreateProcessDeviceIdentityAsync();
    const sessionKey = "agent:main:startup-storage-failure";
    const sessionId = "startup-storage-failure-session";
    const runId = "startup-storage-failure-run";
    setRuntimeConfigSnapshot({ agents: { defaults: { workspace: state.workspaceDir } } });
    await replaceSessionEntry(
      { agentId: "main", sessionKey },
      {
        sessionId,
        updatedAt: Date.now(),
        status: "done",
        pendingProjectGitUrl: "https://example.com/synthetic.git",
      },
    );
    const context = createDirectChatContext();
    const ready = createDeferred();
    const workspaceSpy = vi.spyOn(workspace, "prepareSessionWorkspace").mockReturnValue({
      sessionKey,
      assertCurrent: () => {},
      promptReady: ready.promise,
      isReady: () => false,
      getFailure: () => failure,
      waitUntilReady: async () => {
        throw failure;
      },
    });
    const model = vi.spyOn(dispatch, "dispatchInboundMessageWithProjectedDispatcher");
    const finished = createDeferred();
    const launch = agentDispatch.startChatDispatch;
    const dispatchSpy = vi
      .spyOn(agentDispatch, "startChatDispatch")
      .mockImplementation((params) => {
        const result = launch(params);
        void result.then(finished.resolve, finished.reject);
        return result;
      });
    try {
      const respond = vi.fn();
      await handleChatSend({
        req: { type: "req", id: runId, method: "chat.send" },
        params: { sessionKey, message: "hello", idempotencyKey: runId },
        respond,
        context,
        client: null,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ runId, status: "started" }),
        undefined,
        expect.objectContaining({ runId }),
      );
      ready.reject(failure);
      await finished.promise;
      expect(model).not.toHaveBeenCalled();
      expect(context.logGateway.warn).not.toHaveBeenCalled();
      const notices = (
        await loadTranscriptEvents({ agentId: "main", sessionKey, sessionId })
      ).filter((event) => isRecord(event) && event.type === "custom_message");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        customType: "run-failed-before-reply",
        content: "Your request couldn't be completed.",
        details: { runId, ...(notice ? { desktopNotice: notice } : {}) },
      });
      if (!notice) {
        expect(notices[0]).not.toHaveProperty("details.desktopNotice");
      }
      if (diagnostic) {
        expect(notices[0]).toMatchObject({ details: { error: diagnostic } });
        expect(notices[0]).not.toMatchObject({ details: { errorKind: expect.anything() } });
      }
      expect(context.broadcast).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({
          runId,
          state: "error",
        }),
        expect.anything(),
      );
    } finally {
      workspaceSpy.mockRestore();
      model.mockRestore();
      dispatchSpy.mockRestore();
    }
  });
});
