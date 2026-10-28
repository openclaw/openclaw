import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import * as events from "../../auto-reply/reply/session-event-handoff.js";
import { readSessionEventTargetOperatorAuthority } from "../../auto-reply/reply/session-event-target.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { OperatorScope } from "../../gateway/operator-scopes.js";
import { readOperatorToolGatewayAuthority } from "../../gateway/operator-tool-gateway-authority.js";
import { consumeAcceptedPluginGatewayHandoffClaim } from "../../gateway/plugin-tool-handoff-claim.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createPluginRuntimeMock } from "../../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { activatePluginRegistry } from "../../plugins/loader-shared.js";
import {
  markPluginRecordBorrowed,
  markPluginRegistryActive,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { clearActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createPluginToolFactoryContext } from "../../plugins/tool-factory-context.js";
import { bindPluginToolCallbacks } from "../../plugins/tool-factory-runtime.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { wrapToolWithAbortSignal } from "../agent-tools.abort.js";
import { completionConfig } from "../bash-tools.lifecycle.test-support.js";
import { SESSIONS_YIELD_ABORT_REASON } from "../embedded-agent-runner/run/attempt-sessions-yield.js";
import { runEmbeddedAgent } from "../embedded-agent.js";
import { createOperationalRunInstanceRef } from "../operational-run-instance.js";
import { preparePluginToolExecutionCapabilities } from "../plugin-tool-execution.js";
import type { AgentToolResult } from "../runtime/index.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";

// The resumed event executes through the real session dispatcher; only model execution is fixed.
vi.mock("../embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../../auto-reply/dispatch.js"),
  import("../../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

afterEach(async () => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
  await clearActivePluginRegistry();
});

it.each([false, true])(
  "runs the registered plugin Gateway handoff after yield (service revoked: %s)",
  async (revokeService) => {
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true, env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const method = "tools.gitlab.publication.publish";
        const sessionKey = "agent:main:plugin-handoff";
        const sessionId = "plugin-handoff-session";
        const runId = "plugin-handoff-run";
        const session = { agentId: "main", sessionKey };
        const scopes: OperatorScope[] = ["operator.sessions.write"];
        const config: OpenClawConfig = {
          agents: completionConfig(state.workspaceDir).agents,
          gateway: {
            roles: {
              default: "guest",
              definitions: {
                guest: { scopes, agents: ["main"], sessions: { others: "none" } },
              },
            },
          },
          plugins: { enabled: false },
          skills: { load: { watch: false } },
        };
        setRuntimeConfigSnapshot(config);
        await state.writeConfig(config);
        const client = createOperatorClient({ profileName: "plugin-handoff-owner", scopes });
        const profileId = client.authenticatedUserProfile!.profileId;
        client.internal = {
          authenticatedOperator: true,
          operatorRoleActor: { kind: "operator", profileId },
          operatorAccessAuthority: {
            assertCurrent() {},
            signal: new AbortController().signal,
            gatewayAccessGrant: null,
          },
        };
        await upsertSessionEntryCore(session, {
          sessionId,
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: profileId },
        });
        const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
        const operation = createTestReplyOperation({
          sessionKey,
          sessionId,
          target: captureSessionTarget({
            storeScope: storePath,
            sessionKey,
            incarnation: sessionId,
          }),
        });
        operation.setPhase("running");
        operation.attachBackend({ kind: "embedded", runId, cancel() {} });
        const runAbort = new AbortController();
        const cleanup = createDeferredCore();
        const resumed = createDeferredCore<string>();
        const statusPending = createDeferredCore<AgentToolResult<unknown>>();
        const observed: Array<{ profileId: string; pluginId: string | undefined }> = [];
        const allowed: string[] = [];
        const handler: GatewayRequestHandler = (options) => {
          const claim = consumeAcceptedPluginGatewayHandoffClaim(options, {
            pluginId: "gitlab",
            toolName: "gitlab_publish",
          });
          claim.assertCurrent();
          expect(options.client?.internal?.operatorRunAuthority?.source).toBe(
            claim.operatorAuthority.source,
          );
          expect(options.client?.internal?.operatorRunAuthority?.profileId).toBe(
            claim.operatorAuthority.profileId,
          );
          observed.push({
            profileId: claim.operatorAuthority.profileId,
            pluginId: options.client?.internal?.pluginRuntimeOwnerId,
          });
          options.respond(true, { status: "published", requestId: "handoff-publication" });
        };
        const context = createContext(
          [[method, "operator.sessions.write", "sessions", handler]],
          () => config,
        );
        context.resolveGatewayContext = () => context;
        runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
          const admission = params.preparedRunAdmission;
          assert(admission, "Expected resumed Gateway admission");
          const admitted = await admission.admit("gateway", params.runId);
          expect(readAdmittedRunOperatorAuthority(admitted)).toMatchObject({ profileId, scopes });
          params.onExecutionPhase?.({ phase: "model_call_started" });
          await params.onExecutionStarted?.();
          await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
          return { payloads: [{ text: "Publication resumed" }], meta: { durationMs: 1 } };
        });

        const builder = createTestPluginRegistry(createPluginRuntimeMock());
        const record = createPluginRecord({
          id: "gitlab",
          origin: "bundled",
          contracts: { tools: ["gitlab_publish"] },
        });
        builder.registry.plugins.push(record);
        const api = builder.createApi(record, { config, registrationMode: "full" });
        api.registerTool(
          {
            contextVersion: 2,
            create: (factoryContext) => ({
              name: "gitlab_publish",
              label: "GitLab publish",
              description: "Publish the current task",
              parameters: {
                type: "object",
                properties: { action: { type: "string" } },
              },
              execute: (_toolCallId, input) =>
                (input as { action?: string }).action === "status"
                  ? statusPending.promise
                  : factoryContext.gatewayHandoff!({
                      method,
                      params: { sessionKey, title: "Draft" },
                    }),
            }),
          },
          { name: "gitlab_publish", gatewayHandoffMethods: [method] },
        );
        activatePluginRegistry(builder.registry, null, "gateway-bindable");
        const entry = builder.registry.tools[0];
        assert(entry, "Expected registered plugin tool");
        const borrower = createEmptyPluginRegistry();
        borrower.plugins.push(record);
        borrower.tools.push(entry);
        markPluginRecordBorrowed(borrower, record);
        markPluginRegistryActive(borrower);

        let receipt: ReturnType<typeof events.enqueueSessionEventForHost> | undefined;
        const enqueueReal = events.enqueueSessionEventForHost;
        const enqueue = vi
          .spyOn(events, "enqueueSessionEventForHost")
          .mockImplementation((text, options) => {
            expect(options).toMatchObject({
              agentId: "main",
              sessionKey,
              source: "tool_handoff",
              expectedTarget: { sessionId },
            });
            expect(readSessionEventTargetOperatorAuthority(options.expectedTarget!)).toMatchObject({
              profileId,
              scopes,
            });
            resumed.resolve(text);
            receipt = enqueueReal(text, options);
            return receipt;
          });

        try {
          await withPluginRuntimeGatewayRequestScope(
            {
              client,
              context,
              resolveGatewayContext: () => context,
              isWebchatConnect: () => false,
            },
            () =>
              withOperatorToolGatewayAuthority({ scopes }, () =>
                withSessionControllerOwner(operation, async () => {
                  const operatorAuthority =
                    readOperatorToolGatewayAuthority()?.operatorRunAuthority;
                  assert(operatorAuthority, "Expected current operator source");
                  const factoryContext = createPluginToolFactoryContext({
                    entry,
                    registry: borrower,
                    context: { agentId: "main", sessionKey, sessionId },
                    assertInvocationCurrent: () => runAbort.signal.throwIfAborted(),
                    bindExecutionCapabilities: preparePluginToolExecutionCapabilities({
                      agentId: "main",
                      sessionKey,
                      sessionId,
                      runId,
                      onYield: () => {
                        runAbort.abort(SESSIONS_YIELD_ABORT_REASON);
                        operation.completeWithAfterClearBarrier(cleanup.promise);
                        markPluginRegistryRetired(borrower);
                      },
                    }),
                  });
                  const raw = entry.factory(factoryContext);
                  assert(raw && !Array.isArray(raw), "Expected one plugin tool");
                  const tool = wrapToolWithAbortSignal(
                    bindPluginToolCallbacks(
                      entry,
                      borrower,
                      raw,
                      factoryContext.assertInvocationCurrent,
                    ),
                    runAbort.signal,
                  );
                  const { result, siblingOutcome } = await withGatewayToolCallerIdentity(
                    {
                      ...session,
                      operatorAuthority,
                      operationalRunInstance: createOperationalRunInstanceRef(runId),
                      receiptAuthority: () => !runAbort.signal.aborted,
                      approvalSignals: [runAbort.signal],
                      assertToolAllowed: (name) => {
                        allowed.push(name);
                        if (name !== "gitlab_publish") {
                          throw new Error("Different tool is not admitted");
                        }
                      },
                    },
                    async () => {
                      // Both invocations share the run abort, but only publish accepts a
                      // Gateway handoff. A pending status call must cancel promptly.
                      const siblingOutcome = tool.execute("status", { action: "status" }).then(
                        () => ({ kind: "resolved" as const }),
                        (error: unknown) => ({ kind: "rejected" as const, error }),
                      );
                      const result = await tool.execute("publish", { action: "publish" });
                      return { result, siblingOutcome: await siblingOutcome };
                    },
                  );
                  expect(siblingOutcome).toMatchObject({
                    kind: "rejected",
                    error: expect.objectContaining({ name: "AbortError" }),
                  });
                  expect(result.details).toMatchObject({ status: "started", yielded: true });
                  expect(allowed).toEqual(["gitlab_publish", "gitlab_publish"]);
                  expect(observed).toHaveLength(0);
                  if (revokeService) {
                    markPluginRegistryRetired(builder.registry);
                  }
                  cleanup.resolve(undefined);
                  const text = await resumed.promise;
                  if (revokeService) {
                    expect(text).toContain("no longer active");
                    expect(observed).toHaveLength(0);
                  } else {
                    expect(text).toContain('"status":"published"');
                    expect(observed).toEqual([{ profileId, pluginId: "gitlab" }]);
                  }
                  expect(enqueue).toHaveBeenCalledOnce();
                  expect(await receipt?.settled).toMatchObject({
                    status: "completed",
                    executionStarted: true,
                  });
                  expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
                }),
              ),
          );
        } finally {
          statusPending.resolve({ content: [{ type: "text", text: "late status" }] });
          cleanup.resolve(undefined);
          operation.complete();
        }
      },
    );
  },
);
