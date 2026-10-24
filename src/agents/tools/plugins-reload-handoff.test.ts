import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi, type TestContext } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { createTestReplyOperation } from "../../auto-reply/reply/reply-run-registry.test-helpers.js";
import * as events from "../../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readOperatorToolGatewayAuthority } from "../../gateway/operator-tool-gateway-authority.js";
import type { GatewayRequestHandler } from "../../gateway/server-methods/types.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import * as exec from "../../infra/exec-request-context.js";
import { resetSystemEventsForTest } from "../../infra/system-events.js";
import { resolveMemoryAudienceFromEntry } from "../../plugins/memory-audience.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { withSessionControllerOwner } from "../../sessions/session-controller.context.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { ensureCanonicalGatewayOwnerProfile } from "../../state/user-profile-writes.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  prepareSystemAgentRunAdmission,
  readAdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { wrapToolWithAbortSignal } from "../agent-tools.abort.js";
import { SESSIONS_YIELD_ABORT_REASON } from "../embedded-agent-runner/run/attempt-sessions-yield.js";
import { buildEmbeddedAttemptToolRunContext } from "../embedded-agent-runner/run/attempt-tool-run-context.js";
import { hasYieldContinuationEvidence } from "../embedded-agent-runner/run/incomplete-turn-resolution.js";
import type { RunEmbeddedAgentParams } from "../embedded-agent-runner/run/params.js";
import { isAsyncStartedToolResult } from "../embedded-agent-tool-results.js";
import { runEmbeddedAgent } from "../embedded-agent.js";
import { createAgentHarnessHostCapabilities } from "../harness/host-capability.js";
import { withPreparedEmbeddedRunToolAuthority } from "../harness/tool-authority.runtime.js";
import { resolveOpenClawPluginToolsForOptionsAsync } from "../openclaw-plugin-tools.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { createPluginsTool } from "./plugins-tool.js";

// mock-isolation: Real reply admission and plugin tools, with deterministic model execution.
vi.mock("../embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const runEmbeddedAgentMock = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../../auto-reply/dispatch.js"),
  import("../../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

const request = { action: "reloadAndResume", pluginId: "reload-fixture" };
const callerRequired = "active Gateway conversation";
afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayWorkAdmission();
});
it.each([
  ["success", '"generation":2'],
  ["without run ID", '"generation":2'],
  ["same-ID without run ID", ""],
  ["same-ID callback", '"generation":2'],
  ["same-ID late construction", '"generation":2'],
  ["same-ID prepublication", '"generation":2'],
  ["same-ID unmatched run", ""],
  ["reload failure", "fixture reload failed"],
  ["permission denied", "operator.admin"],
  ["stop", ""],
])("ends the turn before reload and resumes once: %s", async (outcome, expectedText) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:reload";
    const sessionId = "reload-session";
    const runId = "reload-run";
    const withoutRunId = outcome === "without run ID" || outcome === "same-ID without run ID";
    const refusesHandoff =
      outcome === "same-ID unmatched run" || outcome === "same-ID without run ID";
    const config = { agents: { entries: { main: { workspace: state.workspaceDir } } } };
    setRuntimeConfigSnapshot(config);
    await upsertSessionEntryCore({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
    const runAbort = new AbortController();
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    const runningOperation = (storeScope: string) => {
      const operation = createTestReplyOperation({
        sessionKey,
        sessionId,
        target: captureSessionTarget({ storeScope, sessionKey, incarnation: sessionId }),
      });
      operation.setPhase("running");
      return operation;
    };
    const operation = runningOperation(storePath);
    const other = outcome.startsWith("same-ID")
      ? runningOperation(state.path("other", "sessions.json"))
      : undefined;
    if (outcome !== "same-ID prepublication" && outcome !== "same-ID unmatched run") {
      operation.attachBackend({ kind: "embedded", runId, cancel: () => {} });
    }
    const cleanup = createDeferredCore();
    const resumed = createDeferredCore<string>();
    const plugin = new PluginInstance("reload-fixture");
    const consumer = plugin.retainConsumer();
    const order: string[] = [];
    const endpoint = vi.fn<GatewayRequestHandler>(async ({ respond }) => {
      expect(plugin.hasRetainedConsumers).toBe(false);
      order.push("reload");
      if (outcome === "reload failure") {
        respond(false, undefined, { code: "UNAVAILABLE", message: "fixture reload failed" });
      } else {
        respond(true, { ok: true, runtime: { generation: 2, pluginIds: ["reload-fixture"] } });
      }
    });
    const context = createContext([["plugins.reload", "operator.admin", "plugins", endpoint]]);
    context.getRuntimeConfig = () => config;
    context.resolveGatewayContext = () => context;
    const enqueue = vi
      .spyOn(events, "enqueueSessionEventForHost")
      .mockImplementation((text, opts) => {
        expect(opts).toMatchObject({ sessionKey, expectedTarget: { sessionId } });
        order.push("resume");
        resumed.resolve(text);
        return {
          id: "resume",
          cancel: () => false,
          accepted: Promise.resolve({ ok: true }),
          settled: Promise.resolve({
            status: "completed",
            executionStarted: true,
            delivered: false,
          }),
        };
      });
    const expectNoHandoff = () => {
      expect(endpoint).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    };
    const run = async () => {
      const createTool = () =>
        createPluginsTool({
          sessionId,
          ...(withoutRunId ? {} : { runId }),
          onYield: () => {
            order.push("yield");
            runAbort.abort(SESSIONS_YIELD_ABORT_REASON);
            // Mirror the runtime: cleanup owns its asynchronous consumer close.
            const closing = consumer.close(async () => {
              await cleanup.promise;
              order.push("cleanup");
            });
            operation.completeWithAfterClearBarrier(closing);
          },
        });
      const start = async () => {
        const sourceTool =
          outcome !== "same-ID callback" && other
            ? withSessionControllerOwner(other, createTool)
            : withSessionControllerOwner(operation, createTool);
        const tool = wrapToolWithAbortSignal(sourceTool, runAbort.signal);
        const execute = () =>
          other
            ? withSessionControllerOwner(other, () => tool.execute("handoff", request))
            : tool.execute("handoff", request);
        if (refusesHandoff) {
          await expect(execute()).rejects.toThrow(callerRequired);
          expect(order).toEqual([]);
          expectNoHandoff();
          expect(operation.result).toBeNull();
          expect(other).toMatchObject({ result: null, abortSignal: { aborted: false } });
          return;
        }
        const result = await execute();
        expect(result.details).toMatchObject({ status: "started", async: true, yielded: true });
        const asyncStarted = isAsyncStartedToolResult(result);
        expect(asyncStarted).toBe(true);
        expect(hasYieldContinuationEvidence({ toolMetas: [{ asyncStarted }] })).toBe(true);
        expect(order).toEqual(["yield"]);
        expectNoHandoff();
        await expect(sourceTool.execute("duplicate", request)).rejects.toThrow(
          outcome === "same-ID prepublication"
            ? "This turn already handed off a plugin reload."
            : callerRequired,
        );
      };
      if (outcome === "same-ID prepublication") {
        const admission = prepareSystemAgentRunAdmission(config, runId, "main", "reload-test");
        try {
          const admittedRunContext = await admission.admit("embedded", "reload-test");
          await withPreparedEmbeddedRunToolAuthority(
            {
              admittedRunContext,
              replyOperation: operation,
            },
            {
              config,
              runId,
              sessionId,
              sessionKey,
              agentId: "main",
              sessionFile: state.path("reload-session.jsonl"),
              workspaceDir: state.workspaceDir,
              provider: "openai",
              modelId: "gpt-test",
              sandboxSessionKey: sessionKey,
              senderIsOwner: true,
              abortSignal: runAbort.signal,
            },
            undefined,
            () =>
              withGatewayToolCallerIdentity(
                createAdmittedGatewayToolCallerIdentity({
                  admittedRunContext,
                  agentId: "main",
                  sessionKey,
                  approvalSignals: [runAbort.signal],
                }),
                start,
              ),
          );
        } finally {
          admission.close();
        }
      } else {
        await start();
      }
      if (refusesHandoff) {
        return;
      }
      if (outcome === "stop") {
        exec.cancelExecRequestOwners(exec.activeExecRequestOwners({ sessionKey }, () => true));
        cleanup.resolve();
        await operation.ownerSettlement;
        return;
      }
      cleanup.resolve();
      const text = await resumed.promise;
      expect(order).toEqual([
        "yield",
        "cleanup",
        ...(outcome === "permission denied" ? [] : ["reload"]),
        "resume",
      ]);
      expect(text).toContain(expectedText);
      expect(enqueue).toHaveBeenCalledOnce();
      if (other) {
        expect(other).toMatchObject({
          phase: "running",
          result: null,
          abortSignal: { aborted: false },
        });
      }
    };
    try {
      await withPluginRuntimeGatewayRequestScope(
        { context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
        () =>
          withOperatorToolGatewayAuthority(
            {
              scopes: outcome === "permission denied" ? ["operator.write"] : ["operator.admin"],
              operatorRoleActor: { kind: "system" },
            },
            () =>
              exec.withExecRequestTurn(
                { identity: { agentId: "main", sessionKey, sessionId, runId } },
                () => withGatewayToolCallerIdentity({ agentId: "main", sessionKey }, run),
              ),
          ),
      );
      if (outcome === "stop") {
        expectNoHandoff();
      }
    } finally {
      cleanup.resolve();
      operation.complete();
      other?.complete();
      await consumer.close(() => undefined);
      await plugin.dispose();
    }
  });
});
it("refuses an unsupported caller without pretending to schedule a reload", async () => {
  await expect(createPluginsTool().execute("unsupported", request)).rejects.toThrow(callerRequired);
});

async function configureEventState(
  state: OpenClawTestState,
  overrides: Partial<OpenClawConfig> = {},
) {
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
    plugins: { enabled: false },
    skills: { load: { watch: false } },
    ...overrides,
  };
  setRuntimeConfigSnapshot(config);
  await state.writeConfig(config);
  openOpenClawStateDatabase();
  return config;
}

async function startEmbeddedTurn(params: RunEmbeddedAgentParams, label: string) {
  const admission = expectDefined(params.preparedRunAdmission, label);
  const context = await admission.admit("gateway", params.runId);
  params.onExecutionPhase?.({ phase: "model_call_started" });
  await params.onExecutionStarted?.();
  await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
  return context;
}

type EventReceipt = ReturnType<typeof events.enqueueSessionEventForHost>;

function runEventFixture(
  label: string,
  onTestFinished: TestContext["onTestFinished"],
  run: (state: OpenClawTestState) => Promise<void>,
) {
  const work = withOpenClawTestState({ label, env: { OPENCLAW_TEST_FAST: "0" } }, run);
  // Cancellation must settle the state owner even when the test body times out.
  onTestFinished(async () => {
    await Promise.allSettled([work]);
  });
  return work;
}

it.for([
  "success",
  "reload failure",
  "revoked",
  "cancelled",
  "replaced",
  "system",
  "non-owner",
] as const)(
  "preserves authenticated plugin execution across reload handoff: %s",
  async (scenario, { signal, onTestFinished }) => {
    await runEventFixture("reload-owner-authority", onTestFinished, async (state) => {
      await using cache = createPluginCache();
      return await withPluginCache(cache, async () => {
        const sessionKey = "agent:main:reload-owner";
        const sessionId = "11111111-1111-4111-8111-111111111111";
        const scope = { agentId: "main", sessionKey };
        const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
        const pluginRoot = state.statePath("owner-probe");
        const readsFile = state.path("owner-reads.txt");
        await state.writeJson("owner-probe/package.json", {
          name: "owner-probe",
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        });
        await state.writeJson("owner-probe/openclaw.plugin.json", {
          id: "owner-probe",
          contracts: { tools: ["owner_probe"] },
          configSchema: { type: "object", additionalProperties: false },
        });
        await state.writeText(
          "owner-probe/index.cjs",
          `module.exports = { id: "owner-probe", register(api) {
          api.registerTool({ contextVersion: 2, create(context) {
            if (context.senderIsOwner !== true) throw new Error("Live authenticated private owner session required");
            context.assertInvocationCurrent();
            if (context.sessionKey !== "${sessionKey}" || context.sessionId !== "${sessionId}" || context.sandboxed) {
              throw new Error("Exact live unsandboxed owner session incarnation required");
            }
            if (context.memoryAudience?.kind !== "owner-private") throw new Error("Current private-agent Memory audience required");
            context.assertMemoryAudienceCurrent();
            return { name: "owner_probe", label: "Owner probe", description: "Read a synthetic owner record",
              parameters: { type: "object", properties: {} },
              async execute() {
                context.assertInvocationCurrent(); context.assertMemoryAudienceCurrent();
                require("node:fs").appendFileSync(${JSON.stringify(readsFile)}, "read\\n");
                return { content: [{ type: "text", text: "owner record" }] };
              }
            };
          } }, { name: "owner_probe" });
        } };`,
        );
        const config = await configureEventState(state, {
          plugins: { enabled: true, allow: ["owner-probe"], load: { paths: [pluginRoot] } },
          tools: { allow: ["owner_probe"], codeMode: false, toolSearch: false },
        });
        await replaceSessionEntry(scope, { sessionId, chatType: "direct", updatedAt: 1 });
        const cleanup = createDeferredCore();
        const toolReady = createDeferredCore();
        const executeRead = createDeferredCore();
        const revocation = new AbortController();
        const enqueued = createDeferredCore<EventReceipt>();
        const enqueue = events.enqueueSessionEventForHost;
        const observer = vi
          .spyOn(events, "enqueueSessionEventForHost")
          .mockImplementation((text, options) => {
            const receipt = enqueue(text, options);
            enqueued.resolve(receipt);
            return receipt;
          });
        const dispatchRuntime = await import("../../auto-reply/dispatch.js");
        const dispatch = dispatchRuntime.dispatchInboundMessageWithRoutedChannelDispatcher;
        const dispatchObserver = vi
          .spyOn(dispatchRuntime, "dispatchInboundMessageWithRoutedChannelDispatcher")
          .mockImplementation((input) => {
            expect(input.ctx).toMatchObject({
              CommandAuthorized: false,
              InternalTurnSource: "event",
              InputProvenance: { kind: "internal_system", sourceTool: "plugin" },
            });
            expect(input.ctx.SenderId).toBeUndefined();
            return dispatch(input);
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
        operation.attachBackend({ kind: "embedded", runId: "reload-source", cancel: () => {} });
        const endpoint = vi.fn<
          import("../../gateway/server-methods/types.js").GatewayRequestHandler
        >(async ({ respond }) => {
          if (scenario === "reload failure") {
            respond(false, undefined, { code: "UNAVAILABLE", message: "fixture reload failed" });
          } else {
            respond(true, { ok: true, runtime: { generation: 2, pluginIds: ["owner-probe"] } });
          }
        });
        const inspect = vi.fn<GatewayRequestHandler>(async ({ respond }) => {
          respond(true, { id: "owner-probe", status: "loaded" });
        });
        const context = createContext(
          [
            ["plugins.reload", "operator.admin", "plugins", endpoint],
            ["plugins.inspect", "operator.read", "plugins", inspect],
          ],
          () => config,
        );
        context.resolveGatewayContext = () => context;
        await ensureCanonicalGatewayOwnerProfile("Synthetic owner");
        const client =
          scenario === "system"
            ? undefined
            : createOperatorClient(
                scenario === "non-owner"
                  ? { profileName: "reload-guest", scopes: ["operator.admin"] }
                  : { profileId: GATEWAY_OWNER_PROFILE_ID, scopes: ["operator.admin"] },
              );
        if (client) {
          client.internal = {
            authenticatedOperator: true,
            operatorRoleActor:
              scenario === "non-owner"
                ? { kind: "operator", profileId: client.authenticatedUserProfile!.profileId }
                : { kind: "system" },
            operatorAccessAuthority: {
              signal: revocation.signal,
              assertCurrent: () => revocation.signal.throwIfAborted(),
            },
          };
        }
        const isOwner = scenario !== "system" && scenario !== "non-owner";
        const invalidated =
          scenario === "revoked" || scenario === "cancelled" || scenario === "replaced";
        const resolveAudience = async (
          senderIsOwner: boolean | undefined,
          assertCallerCurrent: () => void,
        ) => {
          const resolution = await resolveMemoryAudienceFromEntry(
            { ...scope, sessionId, storePath, senderIsOwner, assertCallerCurrent },
            expectDefined(loadSessionEntry(scope), "admitted session"),
          );
          if (resolution.status !== "granted") {
            throw new Error(resolution.reason);
          }
          return resolution;
        };
        runEmbeddedAgentMock.mockReset().mockImplementation(async (params) => {
          const admittedRunContext = await startEmbeddedTurn(params, "resumed owner admission");
          expect(readAdmittedRunOperatorAuthority(admittedRunContext)?.profileId).toBe(
            client?.authenticatedUserProfile?.profileId,
          );
          const audience = await resolveAudience(params.senderIsOwner, () =>
            params.preparedRunAdmission!.assertSourceCurrent(),
          );
          const host = createAgentHarnessHostCapabilities({
            attempt: {
              admittedRunContext,
              runId: params.runId,
              abortSignal: params.abortSignal,
              config: params.config,
              agentId: params.agentId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              sessionTarget: params.sessionTarget,
              permissionMode: params.permissionMode,
              workspaceDir: params.workspaceDir,
              bootstrapWorkspaceDir: params.bootstrapWorkspaceDir,
              cwd: params.cwd,
              toolExecutionAllow: params.toolExecutionAllow,
              toolsAllow: params.toolsAllow,
              runtimePluginToolGrant: params.runtimePluginToolGrant,
              trigger: params.trigger,
            },
            pluginId: "openclaw",
          });
          try {
            const tools = await expectDefined(
              host.capabilities.createToolSurfaceAsync,
              "tool surface",
            )({
              ...buildEmbeddedAttemptToolRunContext({
                ...params,
                model:
                  params.provider && params.model
                    ? { provider: params.provider, id: params.model }
                    : undefined,
              }),
              config: params.config,
              agentId: params.agentId,
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              workspaceDir: state.workspaceDir,
              cwd: state.workspaceDir,
              memoryAudience: audience.audience,
              toolConstructionPlan: {
                includeBaseCodingTools: false,
                includeShellTools: false,
                includeChannelTools: false,
                includeOpenClawTools: false,
                includePluginTools: true,
              },
            });
            const probe = tools.find((tool) => tool.name === "owner_probe");
            if (!isOwner) {
              expect(probe).toBeUndefined();
            } else {
              const ownerProbe = expectDefined(probe, "authenticated owner-only plugin tool");
              toolReady.resolve();
              await executeRead.promise;
              const read = ownerProbe.execute("resumed-read", {});
              if (invalidated) {
                await expect(read).rejects.toThrow();
              } else {
                expect(await read).toMatchObject({
                  content: [{ type: "text", text: "owner record" }],
                });
              }
              const caller = expectDefined(
                createAdmittedGatewayToolCallerIdentity({ admittedRunContext, ...scope }),
                "resumed Gateway tool caller",
              );
              const inspection = withGatewayToolCallerIdentity(caller, () =>
                createPluginsTool().execute("resumed-inspect", {
                  action: "inspect",
                  pluginId: "owner-probe",
                }),
              );
              if (invalidated) {
                await expect(inspection).rejects.toThrow();
              } else {
                expect((await inspection).details).toMatchObject({
                  id: "owner-probe",
                  status: "loaded",
                });
              }
            }
            return { payloads: [{ text: "Reload result observed" }], meta: { durationMs: 1 } };
          } finally {
            host.close();
            audience.release();
          }
        });
        let receipt: EventReceipt | undefined;
        try {
          await withPluginRuntimeGatewayRequestScope(
            { context, resolveGatewayContext: () => context, client, isWebchatConnect: () => true },
            () =>
              withOperatorToolGatewayAuthority(
                {
                  scopes: ["operator.admin"],
                  ...(client ? {} : { operatorRoleActor: { kind: "system" as const } }),
                },
                () =>
                  exec.withExecRequestTurn(
                    { identity: { ...scope, sessionId, runId: "reload-source" } },
                    () =>
                      withGatewayToolCallerIdentity(scope, () =>
                        withSessionControllerOwner(operation, async () => {
                          const sourceAuthority =
                            readOperatorToolGatewayAuthority()?.operatorRunAuthority;
                          expect(sourceAuthority?.profileId).toBe(
                            client?.authenticatedUserProfile?.profileId,
                          );
                          if (isOwner) {
                            const audience = await resolveAudience(true, () =>
                              sourceAuthority!.assertCurrent(),
                            );
                            try {
                              const tools = await resolveOpenClawPluginToolsForOptionsAsync({
                                options: {
                                  config,
                                  runId: "reload-source",
                                  agentSessionKey: sessionKey,
                                  sessionId,
                                  workspaceDir: state.workspaceDir,
                                  senderIsOwner: true,
                                  memoryAudience: audience.audience,
                                  pluginToolAllowlist: ["owner_probe"],
                                  assertInvocationCurrent: () => sourceAuthority!.assertCurrent(),
                                },
                              });
                              const initialProbe = expectDefined(
                                tools.find((tool) => tool.name === "owner_probe"),
                                "initial owner-only plugin tool",
                              );
                              expect(await initialProbe.execute("initial-read", {})).toMatchObject({
                                content: [{ text: "owner record" }],
                              });
                            } finally {
                              audience.release();
                            }
                          }
                          const tool = createPluginsTool({
                            sessionId,
                            runId: "reload-source",
                            onYield: () => {
                              operation.completeWithAfterClearBarrier(cleanup.promise);
                            },
                          });
                          expect(
                            (
                              await tool.execute("reload", {
                                action: "reloadAndResume",
                                pluginId: "owner-probe",
                              })
                            ).details,
                          ).toMatchObject({ status: "started" });
                        }),
                      ),
                  ),
              ),
          );
          cleanup.resolve();
          receipt = await withinTest(enqueued.promise, signal);
          await expect(receipt.accepted).resolves.toEqual({ ok: true });
          if (isOwner) {
            await withinTest(
              Promise.race([
                toolReady.promise,
                receipt.settled.then((outcome) => {
                  throw new Error(
                    `Reload continuation settled before the owner-only tool was ready: ${outcome.status}: ${outcome.error ?? ""}`,
                  );
                }),
              ]),
              signal,
            );
            if (scenario === "revoked") {
              revocation.abort(new Error("synthetic owner grant revoked"));
            }
            if (scenario === "cancelled") {
              exec.cancelExecRequestOwners(
                exec.activeExecRequestOwners({ sessionKey }, () => true),
              );
            }
            if (scenario === "replaced") {
              await replaceSessionEntry(scope, {
                sessionId: "22222222-2222-4222-8222-222222222222",
                chatType: "direct",
                updatedAt: 2,
              });
            }
            executeRead.resolve();
          }
          const outcome = await receipt.settled;
          expect(outcome, outcome.error).toMatchObject({
            status: scenario === "replaced" ? "failed" : invalidated ? "cancelled" : "completed",
            executionStarted: true,
          });
          expect(await fs.readFile(readsFile, "utf8").catch(() => "")).toBe(
            !isOwner ? "" : invalidated ? "read\n" : "read\nread\n",
          );
          expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
          expect(endpoint).toHaveBeenCalledOnce();
          expect(inspect).toHaveBeenCalledTimes(isOwner && !invalidated ? 1 : 0);
        } finally {
          cleanup.resolve();
          executeRead.resolve();
          operation.complete();
          await Promise.allSettled([receipt?.settled]);
          observer.mockRestore();
          dispatchObserver.mockRestore();
          resetSystemEventsForTest();
        }
      });
    });
  },
);
