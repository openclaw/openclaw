import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import * as events from "../../auto-reply/reply/session-event-handoff.js";
import { readSessionEventTargetOperatorAuthority } from "../../auto-reply/reply/session-event-target.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import * as transcript from "../../config/sessions/transcript.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { readSessionMessagesAsync } from "../../gateway/session-transcript-readers.js";
import * as exec from "../../infra/exec-request-context.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.identity.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { wrapToolWithAbortSignal } from "../agent-tools.abort.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import { createCodeModeHarness } from "../code-mode.test-support.js";
import { SESSIONS_YIELD_ABORT_REASON } from "../embedded-agent-runner/run/attempt-sessions-yield.js";
import { createOperationalRunInstanceRef } from "../operational-run-instance.js";
import { createSandboxTestContext } from "../sandbox/test-fixtures.js";
import { clearToolSearchCatalog } from "../tool-search.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { createGitHubPublishTool } from "./github-publish-tool.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
});

it.each(["prepared", "failed", "stop", "undelivered", "reset"] as const)(
  "hands PR preparation to its registered owner after cleanup: %s",
  async (outcome) => {
    await withOpenClawTestState(
      { scenario: "minimal", prepareProfileCatalog: true },
      async (state) => {
        const sessionKey = "agent:main:pr-handoff";
        const sessionId = "pr-handoff";
        const runId = "pr-handoff-run";
        const config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
        setRuntimeConfigSnapshot(config);
        const client = createOperatorClient({
          profileName: "pr-handoff-owner",
          scopes: ["operator.sessions.write"],
        });
        const profileId = client.authenticatedUserProfile!.profileId;
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId,
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: profileId },
          },
        );
        const operation = createTestReplyOperation({
          sessionKey,
          sessionId,
          target: captureSessionTarget({
            storeScope: resolveSessionStorePathCore(undefined, { agentId: "main" }),
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
        const context = createContext(
          [["sessions.github.action", "operator.sessions.write", "sessions", endpoint]],
          () => config,
        );
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
            expect(authority?.scopes).toEqual(["operator.sessions.write"]);
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
            return {
              id: "result",
              cancel: () => false,
              accepted: (async () => {
                if (outcome === "reset") {
                  // A same-ID reset rotates the lifecycle before the abandoned resume reports.
                  await upsertSessionEntryCore(
                    { agentId: "main", sessionKey },
                    { sessionId, updatedAt: 2, lifecycleRevision: "after-reset" },
                  );
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
        try {
          await withPluginRuntimeGatewayRequestScope(
            {
              client,
              context,
              resolveGatewayContext: () => context,
              isWebchatConnect: () => false,
            },
            () =>
              withOperatorToolGatewayAuthority({ scopes: ["operator.sessions.write"] }, () =>
                exec.withExecRequestTurn(
                  { identity: { agentId: "main", sessionKey, sessionId, runId } },
                  () =>
                    // Production callers carry the turn batch receipt and the run abort signal.
                    withGatewayToolCallerIdentity(
                      {
                        agentId: "main",
                        sessionKey,
                        operationalRunInstance: createOperationalRunInstanceRef(runId),
                        receiptAuthority: () => !runAbort.signal.aborted,
                        approvalSignals: [runAbort.signal],
                      },
                      async () => {
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
                          codeMode.catalogRef.current?.entries.some(
                            (entry) => entry.name === "github_publish",
                          ),
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
                          exec.cancelExecRequestOwners(
                            exec.activeExecRequestOwners({ sessionKey }, () => true),
                          );
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
                        }
                        if (outcome === "undelivered") {
                          await noticed.promise;
                          const history = await readSessionMessagesAsync(
                            {
                              agentId: "main",
                              sessionKey,
                              sessionId,
                              storePath: resolveSessionStorePathCore(undefined, {
                                agentId: "main",
                              }),
                            },
                            { mode: "full", reason: "undelivered handoff notice" },
                          );
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
                        } else if (outcome === "reset") {
                          await noticed.promise;
                          const history = await readSessionMessagesAsync(
                            {
                              agentId: "main",
                              sessionKey,
                              sessionId,
                              storePath: resolveSessionStorePathCore(undefined, {
                                agentId: "main",
                              }),
                            },
                            { mode: "full", reason: "reset handoff notice" },
                          );
                          expect(JSON.stringify(history)).not.toContain("could not continue");
                        } else {
                          expect(notice).not.toHaveBeenCalled();
                        }
                      },
                    ),
                ),
              ),
          );
        } finally {
          cleanup.resolve(undefined);
          operation.complete();
          clearToolSearchCatalog(codeMode.ctx);
        }
      },
    );
  },
);
