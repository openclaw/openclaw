import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../../test/helpers/promise.js";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import * as events from "../../auto-reply/reply/session-event-handoff.js";
import { readSessionEventTargetOperatorAuthority } from "../../auto-reply/reply/session-event-target.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as transcript from "../../config/sessions/transcript.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareGitHubPublicationRequesterV2 } from "../../gateway/github-publication-requester.js";
import type { OperatorScope } from "../../gateway/operator-scopes.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { readSessionMessagesAsync } from "../../gateway/session-transcript-readers.js";
import * as exec from "../../infra/exec-request-context.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.identity.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readAdmittedRunOperatorAuthority } from "../admitted-run-context.js";
import { wrapToolWithAbortSignal } from "../agent-tools.abort.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import { createCodeModeHarness } from "../code-mode.test-support.js";
import { SESSIONS_YIELD_ABORT_REASON } from "../embedded-agent-runner/run/attempt-sessions-yield.js";
import { runEmbeddedAgent } from "../embedded-agent.js";
import { createOperationalRunInstanceRef } from "../operational-run-instance.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { clearToolSearchCatalog } from "../tool-search.js";
import {
  captureGatewayToolCallerAssertion,
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { createGitHubPublishTool } from "./github-publish-tool.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";

// mock-isolation: Preserve real event admission and Gateway dispatch; replace only model execution.
vi.mock("../embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../../auto-reply/dispatch.js"),
  import("../../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
  resetSystemEventsForTest();
});

it.for(["prepared", "failed", "stop", "undelivered", "reset"] as const)(
  "hands PR preparation to its registered owner after cleanup: %s",
  async (outcome, { signal }) => {
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true, env: { OPENCLAW_TEST_FAST: "0" } },
      async (state) => {
        const sessionKey = "agent:main:pr-handoff";
        const sessionId = "pr-handoff";
        const runId = "pr-handoff-run";
        const scope = { agentId: "main", sessionKey };
        const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
        const scopes: OperatorScope[] = ["operator.sessions.read", "operator.sessions.write"];
        const config: OpenClawConfig = {
          agents: {
            entries: { main: { workspace: state.workspaceDir } },
            defaults: {
              workspace: state.workspaceDir,
              skipBootstrap: true,
              model: { primary: "mock-openai/gpt-5.6-luna" },
              models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
            },
          },
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
        const client = createOperatorClient({
          profileName: "pr-handoff-guest",
          scopes,
        });
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
        await upsertSessionEntryCore(scope, {
          sessionId,
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: profileId },
        });
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
        const order: string[] = [];
        const endpoint = vi.fn<GatewayRequestHandler>(async ({ params, respond }) => {
          expect(params).toMatchObject({ sessionKey, action: "prepare_pr" });
          expect(getGatewayToolCallerIdentity()?.workspacePrAdoptionSessionId).toBe(sessionId);
          expect(getSessionControllerEntryForOperation(operation).successorBarrier).toBeDefined();
          order.push("prepare");
          if (outcome === "failed") {
            respond(false, undefined, { code: "UNAVAILABLE", message: "Saved source preserved" });
          } else {
            respond(true, {
              status: "prepared",
              url: "https://github.com/example/repo/pull/1",
              headCommit: "a".repeat(40),
              headChanged: false,
              changedPaths: Array.from({ length: 10000 }, (_, i) => `src/file-${i}.ts`),
              conflictPaths: [],
              review: { mode: "local", base: "b".repeat(40) },
            });
          }
        });
        const publish = vi.fn<GatewayRequestHandler>(async (options) => {
          const admitted = await prepareGitHubPublicationRequesterV2(options, scope);
          try {
            admitted.requester.assertCurrent();
            expect(admitted.requester.snapshot).toMatchObject({
              actor: { kind: "operator", profileId },
              scopes,
            });
            expect(options.params).toMatchObject({ sessionKey, idempotencyKey: "resumed-publish" });
            options.respond(true, { status: "requested", requestId: "synthetic-publication" });
          } finally {
            admitted.release();
          }
        });
        const forbidden = vi.fn<GatewayRequestHandler>(async ({ respond }) => respond(true, {}));
        const context = createContext(
          [
            ["sessions.github.action", "operator.sessions.write", "sessions", endpoint],
            ["sessions.github.publish", "operator.sessions.write", "sessions", publish],
            ["tools.effective", "operator.read", "tools", forbidden],
            ["plugins.reload", "operator.admin", "plugins", forbidden],
          ],
          () => config,
        );
        context.resolveGatewayContext = () => context;
        runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
          const admission = expectDefined(params.preparedRunAdmission, "resumed guest admission");
          const admittedRunContext = await admission.admit("gateway", params.runId);
          params.onExecutionPhase?.({ phase: "model_call_started" });
          await params.onExecutionStarted?.();
          await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
          expect(params.senderIsOwner).not.toBe(true);
          expect(readAdmittedRunOperatorAuthority(admittedRunContext)).toMatchObject({
            profileId,
            scopes,
          });
          const caller = expectDefined(
            createAdmittedGatewayToolCallerIdentity({ admittedRunContext, ...scope }),
            "resumed guest caller",
          );
          await withGatewayToolCallerIdentity(caller, async () => {
            expect(
              (await createGitHubPublishTool().execute("resumed-publish", {})).details,
            ).toMatchObject({ status: "requested", requestId: "synthetic-publication" });
            await expect(
              callAgentToolGatewayRequest({
                method: "tools.effective",
                params: scope,
              }),
            ).rejects.toThrow("operator.read");
            await expect(
              callAgentToolGatewayRequest({ method: "plugins.reload", params: {} }),
            ).rejects.toThrow("operator.admin");
          });
          return { payloads: [{ text: "Guest publication admitted" }], meta: { durationMs: 1 } };
        });
        let receipt: ReturnType<typeof events.enqueueSessionEventForHost> | undefined;
        const enqueueReal = events.enqueueSessionEventForHost;
        let resumedCaller: { identity: unknown; error?: unknown } | undefined;
        const noticed = createDeferredCore();
        const appendNotice = transcript.appendAssistantMessageToSessionTranscript;
        const notice = vi
          .spyOn(transcript, "appendAssistantMessageToSessionTranscript")
          .mockImplementation(async (params) => {
            try {
              return await appendNotice(params);
            } finally {
              noticed.resolve(undefined);
            }
          });
        const codeMode = createCodeModeHarness();
        const enqueue = vi
          .spyOn(events, "enqueueSessionEventForHost")
          .mockImplementation((text, options) => {
            expect(options).toMatchObject({ sessionKey, expectedTarget: { sessionId } });
            const authority =
              options.expectedTarget &&
              readSessionEventTargetOperatorAuthority(options.expectedTarget);
            expect(authority?.profileId).toBe(profileId);
            expect(authority?.scopes).toEqual(scopes);
            expect(text.length).toBeLessThan(4096);
            expect(
              getSessionControllerEntryForOperation(operation).successorBarrier,
            ).toBeUndefined();
            // Resume dispatch consults the ambient caller before its own run binds tools; the
            // yielded turn's retired receipt and aborted signal must not be ambient here.
            resumedCaller = { identity: getGatewayToolCallerIdentity() };
            try {
              captureGatewayToolCallerAssertion()?.();
            } catch (error) {
              resumedCaller.error = error;
            }
            order.push("resume");
            resumed.resolve(text);
            if (outcome === "prepared") {
              receipt = enqueueReal(text, options);
              return receipt;
            }
            return {
              id: "result",
              cancel: () => false,
              accepted: (async () => {
                if (outcome === "reset") {
                  // A same-ID reset rotates the lifecycle before the abandoned resume reports.
                  await upsertSessionEntryCore(scope, {
                    sessionId,
                    updatedAt: 2,
                    lifecycleRevision: "after-reset",
                  });
                }
                return outcome === "undelivered" || outcome === "reset"
                  ? { ok: false as const, error: "Session event was abandoned before execution" }
                  : { ok: true as const };
              })(),
              settled: Promise.resolve({
                status: "completed",
                executionStarted: true,
                delivered: false,
              }),
            };
          });
        const exercise = async () => {
          const wrapped = withSessionControllerOwner(operation, () =>
            wrapToolWithAbortSignal(
              createGitHubPublishTool({
                sessionId,
                runId,
                // An ordinary local Docker conversation, as the visibility rule admits.
                sandbox: createSandboxTestContext({
                  overrides: {
                    sessionKey,
                    workspaceSource: undefined,
                    backend: { id: "docker" } as never,
                  },
                }),
                onYield() {
                  order.push("yield");
                  runAbort.abort(SESSIONS_YIELD_ABORT_REASON);
                  operation.completeWithAfterClearBarrier(
                    cleanup.promise.then(() => {
                      order.push("cleanup");
                    }),
                  );
                },
              }),
              runAbort.signal,
            ),
          );
          // Code Mode keeps the yielding call direct, as it does sessions_yield.
          const surface = applyCodeModeCatalog({
            tools: [...codeMode.tools, wrapped],
            config: codeMode.config,
            catalogRef: codeMode.catalogRef,
          });
          expect(
            codeMode.catalogRef.current?.entries.some((entry) => entry.name === "github_publish"),
          ).toBe(false);
          const tool = expectDefined(
            surface.tools.find((candidate) => candidate.name === "github_publish"),
            "direct github_publish",
          );
          const result = await tool.execute("prepare", {
            action: "prepare_pr",
            pullRequestUrl: "https://github.com/example/repo/pull/1",
          });
          expect(result.details).toMatchObject({
            status: "started",
            async: true,
            yielded: true,
          });
          expect(order).toEqual(["yield"]);
          expect(endpoint).not.toHaveBeenCalled();
          if (outcome === "stop") {
            exec.cancelExecRequestOwners(exec.activeExecRequestOwners({ sessionKey }, () => true));
          }
          cleanup.resolve(undefined);
          if (outcome === "stop") {
            await operation.ownerSettlement;
            expect(endpoint).not.toHaveBeenCalled();
            expect(enqueue).not.toHaveBeenCalled();
          } else {
            expect(await resumed.promise).toContain(
              outcome === "failed" ? "Saved source preserved" : '"status":"prepared"',
            );
            expect(order).toEqual(["yield", "cleanup", "prepare", "resume"]);
            expect(enqueue).toHaveBeenCalledOnce();
            expect(resumedCaller).toEqual({ identity: undefined });
            if (outcome === "prepared") {
              const settled = await withinTest(
                expectDefined(receipt, "actual event receipt").settled,
                signal,
              );
              expect(settled, settled.error).toMatchObject({
                status: "completed",
                executionStarted: true,
              });
              expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
              expect(forbidden).not.toHaveBeenCalled();
              expect(publish).toHaveBeenCalledOnce();
            }
          }
          if (outcome === "undelivered" || outcome === "reset") {
            await noticed.promise;
            const history = await readSessionMessagesAsync(
              {
                ...scope,
                sessionId,
                storePath,
              },
              { mode: "full", reason: `${outcome} handoff notice` },
            );
            if (outcome === "reset") {
              expect(JSON.stringify(history)).not.toContain("could not continue");
              return;
            }
            const last = history.at(-1) as {
              role?: string;
              content?: Array<{ text?: string }>;
            };
            expect(last.role).toBe("assistant");
            const text = last.content?.map((part) => part.text ?? "").join("") ?? "";
            expect(text).toContain(
              "PR preparation could not continue this conversation automatically: Session event was abandoned before execution",
            );
            expect(text).toContain('"status":"prepared"');
          } else {
            expect(notice).not.toHaveBeenCalled();
          }
        };
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
                exec.withExecRequestTurn({ identity: { ...scope, sessionId, runId } }, () =>
                  // Production callers carry the turn batch receipt and the run abort signal.
                  withGatewayToolCallerIdentity(
                    {
                      ...scope,
                      operationalRunInstance: createOperationalRunInstanceRef(runId),
                      receiptAuthority: () => !runAbort.signal.aborted,
                      approvalSignals: [runAbort.signal],
                    },
                    exercise,
                  ),
                ),
              ),
          );
        } finally {
          cleanup.resolve(undefined);
          operation.complete();
          receipt?.cancel();
          await Promise.allSettled([receipt?.settled]);
          clearToolSearchCatalog(codeMode.ctx);
        }
      },
    );
  },
);
