import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { captureAgentToolSourceExecutionGuard } from "../agents/agent-tool-source-execution-guard.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.pending-inputs.js";
import {
  resolveSqliteStoreScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { registerInternalHook, unregisterInternalHook } from "../hooks/internal-hooks.js";
import { markPluginRegistryActive } from "../plugins/registry-lifecycle.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createPluginRecord } from "../plugins/status.test-fixtures.js";
import {
  dispatchGatewayMethodInProcess,
  dispatchTrustedPluginGatewayMethod,
} from "./server-plugins.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { loadSessionEntry } from "./session-utils.js";
import { installGatewayTestHooks, prepareGatewayReplyRuntimeForTest } from "./test-helpers.js";

describe("spawn input ownership transfer", () => {
  let harness: GatewayServerHarness;
  let kernel: Awaited<ReturnType<(typeof import("./server-kernel.js"))["createGatewayKernel"]>>;
  installGatewayTestHooks({
    scope: "suite",
    setup: async () => {
      const module = await import("./server-kernel.js");
      const create = module.createGatewayKernel;
      const capture = vi
        .spyOn(module, "createGatewayKernel")
        .mockImplementation(async (...args) => {
          kernel = await create(...args);
          return kernel;
        });
      try {
        harness = await startGatewayServerHarness();
      } finally {
        capture.mockRestore();
      }
    },
    cleanup: async () => {
      await harness?.close();
    },
  });

  it.for([
    { owner: "spawn", boundary: "before staging" },
    { owner: "spawn", boundary: "after acceptance" },
    { owner: "spawn", boundary: "child abort" },
    { owner: "spawn", boundary: "before reset" },
    { owner: "spawn", boundary: "live reset" },
    { owner: "plugin grant", boundary: "before facade" },
    { owner: "plugin grant", boundary: "before staging" },
    { owner: "plugin grant", boundary: "after acceptance" },
    { owner: "plugin grant", boundary: "expired grant" },
  ] as const)(
    "keeps $owner input authority at its current owner: $boundary",
    async ({ owner, boundary }, { signal }) => {
      await prepareGatewayReplyRuntimeForTest();
      const context = kernel.gatewayRequestContext;
      const cfg = context.getRuntimeConfig();
      const runId = randomUUID();
      const parentKey = `agent:main:parent:${runId}`;
      const childKey = `agent:main:subagent:${runId}`;
      const sessionId = `child-${runId}`;
      await sessionAccessor.upsertSessionEntryCore(
        { agentId: "main", sessionKey: childKey },
        { sessionId, updatedAt: Date.now() },
      );
      const loaded = loadSessionEntry(childKey, { agentId: "main" });
      const admission = prepareAgentRunAdmission({
        cfg,
        operationalRunInstance: createOperationalRunInstanceRef(`parent-${runId}`),
        facts: {
          runId: `parent-${runId}`,
          agentId: "main",
          ingress: { kind: "system", boundary: "spawn-input-proof", state: "present" },
        },
      });
      const admitted = await admission.admit("embedded");
      let guard = await withGatewayToolCallerIdentity(
        createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: "main",
          sessionKey: parentKey,
        }),
        () => captureAgentToolSourceExecutionGuard(),
      );
      let closeAuthority = () => admission.close();
      let pluginRuntime: ReturnType<typeof createPluginRuntime> | undefined;
      let rejection = "tool invocation authority is no longer active";
      if (owner === "plugin grant") {
        const builder = createPluginRegistry({
          logger: { info() {}, warn() {}, error() {}, debug() {} },
          runtime: createPluginRuntime({
            gateway: {
              isAvailable: async () => true,
              request: (method, params, options) =>
                dispatchTrustedPluginGatewayMethod(method, params, options, () => context),
            },
          }),
          activateGlobalSideEffects: false,
        });
        const record = createPluginRecord({ id: "admission-proof", origin: "bundled" });
        pluginRuntime = builder.createApi(record, {
          config: cfg,
          registrationMode: "full",
        }).runtime;
        builder.registry.plugins.push(record);
        markPluginRegistryActive(builder.registry);
        const grants = pluginRuntime.crossSessionGrants;
        const authority = {
          grantId: runId,
          subjectId: "remote-peer",
          subjectBinding: "peer-key-epoch-1",
          targetSessionId: sessionId,
          generation: 0,
          signal,
        };
        // Scope wall-clock control to synchronous store operations; the Gateway runs on real time.
        const now = Date.now();
        const clock = boundary === "expired grant" ? vi.spyOn(Date, "now") : undefined;
        try {
          clock?.mockReturnValue(now - 8 * 24 * 60 * 60_000);
          expect(
            grants.create({ ...authority, role: "issuer", targetSessionKey: childKey }, signal),
          ).toBe(true);
          if (clock) {
            expect(grants.allowStanding(authority)).toBe(true);
            clock.mockReturnValue(now - 2 * 24 * 60 * 60_000);
            expect(grants.applyRevocation({ ...authority, generation: 1 })).toBe(false);
          }
        } finally {
          clock?.mockRestore();
        }
        rejection = "grant revoked before input admission";
        guard = () => {
          if (!grants.authorize(authority)) {
            throw new Error(rejection);
          }
        };
        closeAuthority = () => {
          grants.revoke({ grantId: runId, expectedGeneration: 0, signal });
        };
      }
      if (boundary === "before reset" || boundary === "live reset") {
        const before = loadSessionEntry(childKey, { agentId: "main" }).entry;
        let hookCalls = 0;
        const onReset = (event: import("../hooks/internal-hooks.js").InternalHookEvent) => {
          if (event.sessionKey !== childKey) {
            return;
          }
          hookCalls++;
          if (boundary === "before reset") {
            admission.close();
          }
        };
        registerInternalHook("command:new", onReset);
        try {
          const reset = dispatchGatewayMethodInProcess(
            "agent",
            { message: "/new", sessionKey: childKey, idempotencyKey: runId },
            {
              forceSyntheticClient: true,
              syntheticScopes: ["operator.admin"],
              resolveGatewayContext: () => context,
              sessionMutationCommitGuard: guard,
            },
            "session.transcript.batch",
          );
          if (boundary === "before reset") {
            await expect(reset).rejects.toThrow("tool invocation authority is no longer active");
            expect(loadSessionEntry(childKey, { agentId: "main" }).entry).toEqual(before);
          } else {
            await expect(reset).resolves.toMatchObject({ status: "ok", summary: "completed" });
            const after = loadSessionEntry(childKey, { agentId: "main" }).entry;
            expect(after?.sessionId).toBe(sessionId);
            expect(after?.lifecycleRevision).not.toBe(before?.lifecycleRevision);
          }
          expect(hookCalls).toBe(1);
        } finally {
          unregisterInternalHook("command:new", onReset);
          admission.close();
        }
        return;
      }
      const staged = createDeferred();
      const releaseWriter = createDeferred();
      const releaseFacade = createDeferred();
      const facadeEntered = createDeferred();
      const createFacade = context.createAgentTurnFacade!;
      const facadeSpy =
        boundary === "before facade"
          ? vi.spyOn(context, "createAgentTurnFacade").mockImplementationOnce(async (...args) => {
              facadeEntered.resolve();
              await releaseFacade.promise;
              return createFacade(...args);
            })
          : undefined;
      const releaseExecution = createDeferred();
      const executionEntered = createDeferred();
      const release = () => {
        releaseWriter.resolve();
        releaseFacade.resolve();
        releaseExecution.resolve();
      };
      signal.addEventListener("abort", release, { once: true });
      let writer: Promise<unknown> | undefined;
      let execution: Promise<void> | undefined;
      let prepared:
        | import("./agent-turn/agent-run-admission-phase.js").PreparedAgentRunDispatch
        | undefined;
      const executionModule = await import("./agent-turn/agent-run-execution-phase.js");
      const execute = executionModule.startAgentRunExecution;
      const executionSpy = vi
        .spyOn(executionModule, "startAgentRunExecution")
        .mockImplementationOnce((params) => {
          prepared = params.prepared;
          executionEntered.resolve();
          execution = releaseExecution.promise.then(() => execute(params));
          return execution;
        });
      const stage = sessionAccessor.stageSessionPendingInput;
      const stageSpy = vi
        .spyOn(sessionAccessor, "stageSessionPendingInput")
        .mockImplementationOnce(async (...args) => {
          if (boundary === "before staging") {
            const entered = createDeferred();
            writer = runExclusiveSqliteSessionWrite(
              resolveSqliteStoreScope(loaded.storePath, { agentId: "main" }),
              async () => {
                entered.resolve();
                await releaseWriter.promise;
              },
            );
            await entered.promise;
          }
          const pending = stage(...args);
          staged.resolve();
          return await pending;
        });
      let dispatch: Promise<unknown> | undefined;
      try {
        const input = {
          message: "synthetic staged child input",
          sessionKey: childKey,
          expectedExistingSessionId: sessionId,
          idempotencyKey: runId,
        };
        const requestOptions = { assertAdmissionCurrent: guard };
        dispatch = pluginRuntime
          ? pluginRuntime.gateway.request("agent", input, requestOptions)
          : dispatchGatewayMethodInProcess("agent", input, {
              forceSyntheticClient: true,
              resolveGatewayContext: () => context,
              sessionMutationCommitGuard: guard,
            });
        // Changing the caller-owned object cannot detach a fence already submitted to the runtime.
        requestOptions.assertAdmissionCurrent = () => {};
        const outcome = dispatch.then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        if (boundary !== "expired grant") {
          await Promise.race([
            boundary === "before facade" ? facadeEntered.promise : staged.promise,
            outcome.then((value) => {
              if ("error" in value) {
                throw value.error;
              }
              throw new Error(`Dispatch ended before staging: ${JSON.stringify(value)}`);
            }),
          ]);
        }
        if (
          boundary === "before staging" ||
          boundary === "before facade" ||
          boundary === "expired grant"
        ) {
          if (boundary !== "expired grant") {
            closeAuthority();
          }
          releaseWriter.resolve();
          releaseFacade.resolve();
          expect(await outcome).toHaveProperty("error.message", rejection);
          expect(prepared).toBeUndefined();
          expect(
            listSessionPendingInputs({
              agentId: "main",
              sessionKey: childKey,
              sessionId,
              storePath: loaded.storePath,
            }).total,
          ).toBe(0);
        } else {
          expect(await outcome).toHaveProperty("value.status", "accepted");
          await executionEntered.promise;
          const recorder = prepared!.userTurn.recorder!;
          expect(recorder.getPendingInputMessage?.()).toBeDefined();
          closeAuthority();
          expect(() => guard()).toThrow(rejection);
          if (boundary === "child abort") {
            prepared!.activeRunAbort.controller.abort(new Error("child stopped"));
            expect(() => recorder.withPendingInput!(() => undefined)).toThrow("child stopped");
          } else {
            const persisted = await recorder.withPendingInput!(() => recorder.persistApproved());
            expect(persisted?.appended).toBe(true);
            expect(persisted?.message.content).toBe("synthetic staged child input");
            expect(
              listSessionPendingInputs({
                agentId: "main",
                sessionKey: childKey,
                sessionId,
                storePath: loaded.storePath,
              }).total,
            ).toBe(0);
          }
        }
      } finally {
        release();
        await Promise.allSettled([writer, dispatch, execution]);
        admission.close();
        facadeSpy?.mockRestore();
        stageSpy.mockRestore();
        executionSpy.mockRestore();
        signal.removeEventListener("abort", release);
      }
    },
  );
});
