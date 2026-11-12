/** Cancellation, yield, and requester-continuation proofs through native owners. */
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { loadSessionEntry } from "../../../config/sessions/session-accessor.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import { createTestInstance } from "../../../plugins/plugin-instance.test-support.js";
import { PluginInvocationScope } from "../../../plugins/plugin-invocation-scope.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../../../plugins/runtime/gateway-request-scope.js";
import {
  mergeAcceptedSessionSpawnsForRun,
  normalizeAcceptedSessionSpawnResult,
  type AcceptedSessionSpawn,
} from "../../accepted-session-spawn.js";
import {
  readAdmittedRunOperatorAuthority,
  getAdmittedRunDelegatedAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../../admitted-run-context.js";
import type { EmbeddedAgentRunResult } from "../../embedded-agent.js";
import { createAgentHarnessHostCapabilities } from "../../harness/host-capability.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import { createSubagentsTool } from "../../tools/subagents-tool.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { admitEmbeddedRun, recordFinal } from "./subagent-spawn.boundary-run.test-support.js";
import {
  visibleResult,
  type BoundaryHarness,
  type WaitForEmbeddedRun,
} from "./subagent-spawn.fixtures.test-support.js";
import {
  createBoundSpawnInvocation,
  type createSpawnBoundaryParent,
  type createSpawnOperatorSource,
} from "./subagent-spawn.production-boundary.test-support.js";

type BoundParent = Awaited<ReturnType<typeof createSpawnBoundaryParent>>;
export function registerYieldedRequesterBatchCase(
  options: BoundaryHarness & {
    waitForEmbeddedRun: WaitForEmbeddedRun;
    settleRootWork: (keepObserving?: boolean) => Promise<void>;
    createBoundParent: () => Promise<BoundParent>;
    createGuestParent: (audit?: boolean) => Promise<{
      bound: BoundParent;
      source: ReturnType<typeof createSpawnOperatorSource>;
    }>;
  },
) {
  it.for(["system", "guest", "cancel-and-replace", "revoke-after-yield"] as const)(
    "continues a yielded nested parent once through its accepted child batch (%s)",
    async (actor, { signal }) => {
      const registry = await import("../registry/subagent-registry.js");
      const { loadSubagentRegistryFromSqlite } =
        await import("../registry/subagent-registry-state.fixture.test-support.js");
      const { settleSubagentRegistryPersistenceWork } =
        await import("../registry/subagent-registry.persistence.test-support.js");
      const announce = await import("../announce/subagent-announce.js");
      const nativeAnnounce = await vi.importActual<typeof announce>(
        "../announce/subagent-announce.js",
      );
      vi.mocked(announce.runSubagentAnnounceFlow).mockImplementation(
        nativeAnnounce.runSubagentAnnounceFlow,
      );
      const guest =
        actor === "guest" || actor === "revoke-after-yield"
          ? await options.createGuestParent(false)
          : undefined;
      const bound = guest?.bound ?? (await options.createBoundParent());
      const { context, runtime } = await options.createBoundGateway(bound);
      const waitCleanup = new AbortController();
      const waitFacade = await runtime.createAgentTurnFacade({
        client: createSyntheticPluginRuntimeClient({ operatorRoleActor: { kind: "system" } }),
      });
      const waitForRegisteredParent = runtime.lifecycle.waitForAgent.bind(runtime.lifecycle);
      runtime.lifecycle.waitForAgent = <T>(
        params: Parameters<typeof runtime.lifecycle.waitForAgent>[0],
        timeoutMs?: number,
      ): Promise<T> => {
        // The registered parent has no dispatched turn until its children settle.
        if (params.runId === bound.parentRunId) {
          return waitForRegisteredParent<T>(params, timeoutMs);
        }
        return waitFacade.wait<T>(params, timeoutMs, waitCleanup.signal);
      };
      const delivery = await import("../announce/subagent-announce-delivery.js");
      const deliver = delivery.deliverSubagentAnnouncement;
      const delivered = createDeferred<Awaited<ReturnType<typeof deliver>>>();
      const deliveryResults: Array<Awaited<ReturnType<typeof deliver>>> = [];
      const deliveryObserver = vi
        .spyOn(delivery, "deliverSubagentAnnouncement")
        .mockImplementation(async (params) => {
          const result = await deliver(params);
          deliveryResults.push(result);
          if (
            params.sourceTool === "subagent_settle" &&
            params.requesterSessionKey === bound.parentSessionKey
          ) {
            delivered.resolve(result);
          }
          return result;
        });
      const childStarts = Array.from({ length: actor === "cancel-and-replace" ? 3 : 1 }, () =>
        createDeferred(),
      );
      let childCalls = 0;
      const instance = createTestInstance("yield-child-tool");
      const pluginScope = new PluginInvocationScope(createEmptyPluginRegistry(), [instance]);
      const childTool = instance.wrap(() => "CHILD_TOOL_OK");
      const toolResults: string[] = [];
      const deniedTool = createDeferred<unknown>();
      const allowedEffect = createDeferred();
      const finishRevokedCall = createDeferred();
      const target = path.join(
        expectDefined(bound.cfg.agents?.defaults?.workspace, "workspace"),
        "yield-authority-probe.txt",
      );
      if (actor === "revoke-after-yield") {
        await fs.writeFile(target, "before");
      }
      const openFile = vi.spyOn(fs, "open");
      const targetOpens = () =>
        openFile.mock.calls.filter(([name]) => String(name) === target).length;
      const childResult = createDeferred<EmbeddedAgentRunResult>();
      const parentStarted = createDeferred();
      const parentCalls: string[] = [];
      const admissionFailures: unknown[] = [];
      options.runEmbeddedAgent.mockImplementation(async (params) => {
        try {
          const admitted = await admitEmbeddedRun(params);
          if (guest) {
            const authority = readAdmittedRunOperatorAuthority(admitted);
            expect(authority?.profileId).toBe(guest.source.authority.profileId);
            expect(authority?.scopes).toEqual(["operator.sessions.write"]);
            expect(authority?.modelPolicy).toBe(guest.source.authority.modelPolicy);
          }
          await params.onExecutionStarted?.();
          if (params.sessionKey !== bound.parentSessionKey) {
            const assertChildCurrent = expectDefined(
              resolveAdmittedRunActiveAssertion(admitted, params.abortSignal),
              "child execution authority",
            );
            if (actor === "revoke-after-yield") {
              const attempt = {
                runId: params.runId,
                admittedRunContext: admitted,
                agentId: "main",
                config: bound.cfg,
                sessionId: params.sessionId,
                sessionKey: params.sessionKey,
                workspaceDir: params.workspaceDir,
                abortSignal: params.abortSignal,
              };
              const host = createAgentHarnessHostCapabilities({
                pluginId: "yield-authority-fixture",
                attempt,
              });
              try {
                const tools = await host.capabilities.createToolSurfaceAsync!({
                  config: bound.cfg,
                  agentId: "main",
                  sessionKey: params.sessionKey,
                  workspaceDir: params.workspaceDir,
                  includeToolSearchControls: false,
                });
                const write = expectDefined(
                  tools.find((tool) => tool.name === "write"),
                  "real write tool",
                );
                childStarts[childCalls++]!.resolve();
                await childResult.promise;
                await write.execute("allowed-after-yield", { path: target, content: "allowed" });
                await recordFinal(bound, params, "Nested child result.");
                allowedEffect.resolve();
                await finishRevokedCall.promise;
                try {
                  await write.execute("revoked-after-yield", {
                    path: target,
                    content: "forbidden",
                  });
                  deniedTool.resolve(undefined);
                } catch (error) {
                  deniedTool.resolve(error);
                }
                return visibleResult("Nested child result.");
              } finally {
                host.close();
              }
            }
            assertChildCurrent();
            childStarts[childCalls++]!.resolve();
            const aborted = createDeferred<EmbeddedAgentRunResult>();
            const abortChild = () =>
              aborted.resolve({ payloads: [], meta: { durationMs: 1, aborted: true } });
            params.abortSignal?.addEventListener("abort", abortChild, { once: true });
            if (params.abortSignal?.aborted) {
              abortChild();
            }
            let result: EmbeddedAgentRunResult;
            try {
              // A held tool can resume after cancellation; its original authority must reject it.
              result = await Promise.race([childResult.promise, aborted.promise]);
            } finally {
              params.abortSignal?.removeEventListener("abort", abortChild);
            }
            if (result.meta.aborted) {
              return result;
            }
            assertChildCurrent();
            toolResults.push(childTool());
            assertChildCurrent();
            await recordFinal(bound, params, "Nested child result.");
            return result;
          }
          expect(subagentRuns.get(params.runId)?.childSessionKey).toBe(bound.parentSessionKey);
          expect(getAdmittedRunDelegatedAuthority(admitted)).toBeDefined();
          parentCalls.push(params.prompt);
          parentStarted.resolve();
          await recordFinal(bound, params, "Nested parent is complete.");
          return visibleResult("Nested parent is complete.");
        } catch (error) {
          admissionFailures.push(error);
          if (params.sessionKey === bound.parentSessionKey) {
            parentStarted.resolve();
          } else {
            childStarts[childCalls]?.resolve();
          }
          throw error;
        }
      });
      let childRunId: string | undefined;
      const failures: unknown[] = [];
      try {
        await registry.registerSubagentRun({
          runId: bound.parentRunId,
          childSessionKey: bound.parentSessionKey,
          childAgentId: "main",
          sessionEntry: expectDefined(
            loadSessionEntry({ storePath: bound.storePath, sessionKey: bound.parentSessionKey }),
            "registered parent session",
          ),
          requesterSessionKey: "agent:main:main",
          requesterAgentId: "main",
          requesterDisplayKey: "main",
          task: "Continue after an accepted child completes",
          cleanup: "keep",
          expectsCompletionMessage: false,
          gatewayContextResolver: () => context,
        });
        const invokeSpawn = createBoundSpawnInvocation(bound, {
          context: "isolated",
          ...(guest ? { completionTarget: "parent" as const } : {}),
        });
        const acceptedSpawns: AcceptedSessionSpawn[] = [];
        for (const index of childStarts.keys()) {
          const spawned = await pluginScope.run(() => invokeSpawn(`yielded-child-${index}`));
          const accepted = expectDefined(
            normalizeAcceptedSessionSpawnResult(spawned),
            "actual accepted spawn",
          );
          expect(accepted.expectsCompletionMessage).toBe(true);
          acceptedSpawns.push(accepted);
          childRunId = accepted.runId;
          await options.waitForEmbeddedRun(
            bound,
            childRunId,
            childStarts[index]!.promise,
            index + 1,
          );
          if (actor === "cancel-and-replace" && index < 2) {
            const caller = createAdmittedGatewayToolCallerIdentity({
              admittedRunContext: bound.admitted,
              agentId: "main",
              sessionKey: bound.parentSessionKey,
            });
            const cancelled = await withPluginRuntimeGatewayRequestScope(
              {
                context,
                resolveGatewayContext: bound.resolveGatewayContext,
                isWebchatConnect: () => false,
              },
              () =>
                withGatewayToolCallerIdentity(caller, () =>
                  createSubagentsTool({
                    config: bound.cfg,
                    agentSessionKey: bound.parentSessionKey,
                    agentId: "main",
                  }).execute("cancel-before-replacement", {
                    action: "cancel",
                    runId: accepted.runId,
                  }),
                ),
            );
            expect(cancelled.details).toMatchObject({ found: true, killed: true });
            await settleSubagentRegistryPersistenceWork(() => options.settleRootWork(true));
            // The real cancellation owner confirms and retires its acknowledged kills.
            await vi.waitFor(() => {
              for (const cancelledChild of acceptedSpawns) {
                expect(subagentRuns.has(cancelledChild.runId)).toBe(false);
                expect(loadSubagentRegistryFromSqlite().has(cancelledChild.runId)).toBe(false);
              }
            });
          }
        }
        childRunId = expectDefined(childRunId, "remaining child run");
        expect(
          await registry.markRequesterTurnYielded({
            requesterSessionKey: bound.parentSessionKey,
            requesterAgentId: "main",
            requesterTurnRunId: bound.parentRunId,
          }),
        ).toBe(1);
        expect(
          await registry.settleRequesterAfterSessionSpawns({
            requesterSessionKey: bound.parentSessionKey,
            requesterTurnRunId: bound.parentRunId,
            requesterYielded: true,
            // A harness can retain pre-cancellation acceptance projections until turn end.
            acceptedSessionSpawns: mergeAcceptedSessionSpawnsForRun(
              bound.admission.operationalRunInstance,
              acceptedSpawns,
            ),
          }),
        ).toBe(true);
        expect(subagentRuns.get(bound.parentRunId)?.pauseReason).toBe("sessions_yield");
        expect(subagentRuns.get(childRunId)?.requesterSettleWake).toMatchObject({
          requesterYieldBatch: true,
          rearmGeneration: 1,
          batchRunIds: [childRunId],
        });
        bound.admission.close();
        bound.parent.cleanup();
        guest?.source.closeRequest();
        pluginScope.release();
        if (actor === "revoke-after-yield") {
          childResult.resolve(visibleResult("Nested child result."));
          await withinTest(allowedEffect.promise, signal);
          expect(await fs.readFile(target, "utf8")).toBe("allowed");
          const opensBeforeRevocation = targetOpens();
          expect(opensBeforeRevocation).toBeGreaterThan(0);
          expectDefined(guest, "guest operator source").source.revoke();
          finishRevokedCall.resolve();
          expect(String(await withinTest(deniedTool.promise, signal))).toMatch(
            /authority|source|capability|revoked|abort/i,
          );
          expect(targetOpens()).toBe(opensBeforeRevocation);
          expect(await fs.readFile(target, "utf8")).toBe("allowed");
          await vi.waitFor(() => {
            const child = subagentRuns.get(childRunId!);
            expect(!child || child.execution.status === "terminal").toBe(true);
          });
          await settleSubagentRegistryPersistenceWork(() => options.settleRootWork(true));
          expect(toolResults).toEqual([]);
          expect(parentCalls).toEqual([]);
          expect(deliveryResults.some((result) => result.delivered)).toBe(false);
          expect(loadSubagentRegistryFromSqlite().get(childRunId)?.delivery?.status).not.toBe(
            "delivered",
          );
          return;
        }
        childResult.resolve(visibleResult("Nested child result."));
        const deliveryResult = await withinTest(delivered.promise, signal);
        expect(deliveryResult, JSON.stringify(deliveryResult)).toMatchObject({ delivered: true });
        await options.waitForEmbeddedRun(
          bound,
          bound.parentRunId,
          parentStarted.promise,
          childStarts.length + 1,
        );
        await settleSubagentRegistryPersistenceWork(() => options.settleRootWork(true));
        expect(admissionFailures).toEqual([]);
        expect(toolResults).toEqual(["CHILD_TOOL_OK"]);
        expect(parentCalls).toHaveLength(1);
        expect(parentCalls[0]).toContain("Nested child result.");
        const durable = loadSubagentRegistryFromSqlite().get(childRunId);
        expect(durable?.delivery?.status).toBe("delivered");
        expect(durable?.requesterSettleWake).toBeUndefined();
      } catch (error) {
        failures.push(error);
      } finally {
        pluginScope.release();
        childResult.resolve(visibleResult("Nested child result."));
        finishRevokedCall.resolve();
        openFile.mockRestore();
        deliveryObserver.mockRestore();
        runtime.lifecycle.waitForAgent = waitForRegisteredParent;
        waitCleanup.abort(new Error("yielded requester wait cleanup"));
        failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
        options.throwBoundFailures(failures);
      }
    },
  );
}
