// Real-owner fixture shared by delegated and ordinary RPC compatibility cases.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { expect, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import { resetPreparedModelCatalogStateForTest } from "../agents/prepared-model-runtime.test-support.js";
import { createMessageReceiptFromOutboundResults } from "../channels/message/receipt.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.pending-inputs.js";
import {
  registerAgentRunDelegatedAuthorityClosedHandler,
  validateAgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { createAgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import type { PreparedAgentRunDispatch } from "./agent-turn/agent-run-admission-types.js";
import { withInProcessAgentRuntimeIdentity } from "./in-process-agent-runtime-identity.js";
import { dispatchGatewayMethodInProcessRaw } from "./server-plugin-in-process-dispatch.js";
import { startGatewayServerHarness, type GatewayServerHarness } from "./server.e2e-ws-harness.js";
import { loadSessionEntry, resolveGatewayModelSupportsImages } from "./session-utils.js";
import {
  installGatewayTestHooks,
  prepareGatewayReplyRuntimeForTest,
  testState,
} from "./test-helpers.js";
import { getTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

export type Response = Awaited<ReturnType<typeof dispatchGatewayMethodInProcessRaw>>;
export const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X3mIAAAAASUVORK5CYII=";

type ProofPhase =
  | "ordinary-admission"
  | "reset-adopted"
  | "reset-adopted-retry"
  | "strict-delivery-failure"
  | "strict-delivery-retry"
  | "early-rpc"
  | "authority-close"
  | "caller-admitted"
  | "media-transcript"
  | "media-setup"
  | "reset"
  | "reset-committed"
  | "reset-after-close"
  | "reset-retry"
  | "pending-input"
  | "accepted-custody"
  | "pending-retry"
  | "media"
  | "delivery-setup"
  | "delivery"
  | "delivery-retry";
type ProofObservation = {
  mode?: "live" | "revoked" | "accepted custody";
  followUpPending?: boolean;
  deliveryAttempts?: number;
  resetCalls?: number;
  registryLive?: boolean;
  gatewayLive?: boolean;
  admittedLive?: boolean;
  closureCount?: number;
  rpcOk?: boolean;
  rpcAccepted?: boolean;
  rpcInFlight?: boolean;
  rpcInvalidRequest?: boolean;
  imageUnsupported?: boolean;
  imageCapable?: boolean;
  rpcCached?: boolean;
  authorityError?: boolean;
  rowChanged?: boolean;
  sessionPreserved?: boolean;
  transcriptChanged?: boolean;
  pendingCount?: number;
  executionCalls?: number;
  mediaExists?: boolean;
  mediaBytesMatch?: boolean;
  deliveryCount?: number;
  recordingAdapterRetained?: boolean;
};

// Fixed keys and primitive observations only: never serialize RPC payloads,
// errors, identities, file paths, media bytes, or transcript content.
export function observe(phase: ProofPhase, fields: ProofObservation): void {
  console.log(JSON.stringify({ proof: "agent-runtime-authority", version: 1, phase, ...fields }));
}
export function rpcObservation(response: Response): ProofObservation {
  const payload = response.payload;
  return {
    rpcOk: response.ok,
    rpcAccepted:
      payload !== null &&
      typeof payload === "object" &&
      "status" in payload &&
      payload.status === "accepted",
    rpcInFlight:
      payload !== null &&
      typeof payload === "object" &&
      "status" in payload &&
      payload.status === "in_flight",
    rpcInvalidRequest: response.error?.code === "INVALID_REQUEST",
    imageUnsupported:
      response.error?.message?.includes("active model does not accept image inputs") === true,
    rpcCached: response.meta?.cached === true,
    authorityError: response.error?.message?.includes("authority is no longer active") === true,
  };
}
export async function readEffectFile(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function reach<T>(boundary: Promise<T>, request: Promise<Response>): Promise<T> {
  const first = await Promise.race([
    boundary.then((value) => ({ boundary: value })),
    request.then((response) => ({ response })),
  ]);
  if ("response" in first) {
    observe("early-rpc", rpcObservation(first.response));
    throw new Error("RPC ended before proof boundary; see bounded observation");
  }
  return first.boundary;
}

export function installAgentAuthorityProofFixture() {
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

  async function caller(sessionKey: string) {
    const context = kernel.gatewayRequestContext;
    const runId = "proof-caller-" + randomUUID();
    const admission = prepareAgentRunAdmission({
      cfg: context.getRuntimeConfig(),
      operationalRunInstance: createOperationalRunInstanceRef(runId),
      facts: {
        runId,
        agentId: "main",
        ingress: { kind: "system", boundary: "agent-authority-proof", state: "present" },
      },
    });
    const admitted = await admission.admit("embedded");
    const authority = getAdmittedRunDelegatedAuthority(admitted);
    if (!authority) {
      admission.close();
      throw new Error("real run was not admitted");
    }
    const identity = await createAgentRuntimeIdentity({
      agentId: "main",
      sessionKey,
      operationalRunInstance: admitted.operationalRunInstance,
    });
    if (!identity) {
      admission.close();
      throw new Error("real runtime identity missing");
    }
    const closed: string[] = [];
    const unobserve = registerAgentRunDelegatedAuthorityClosedHandler((value, reason) => {
      if (!reason && value.claimId === authority.claimId) {
        closed.push(value.claimId);
      }
    });
    const observation = (): ProofObservation => ({
      registryLive: validateAgentRunDelegatedAuthority(authority),
      gatewayLive: context.validateAgentRuntimeApprovalAuthority?.(identity) === true,
      admittedLive: getAdmittedRunDelegatedAuthority(admitted) !== undefined,
      closureCount: closed.length,
    });
    observe("caller-admitted", observation());
    expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
    expect(context.validateAgentRuntimeApprovalAuthority?.(identity)).toBe(true);
    return {
      identity,
      authority,
      observation,
      revoke: () => {
        admission.close();
        observe("authority-close", observation());
        expect(closed).toEqual([authority.claimId]);
        expect(getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
        expect(validateAgentRunDelegatedAuthority(authority)).toBe(false);
        expect(context.validateAgentRuntimeApprovalAuthority?.(identity)).toBe(false);
      },
      dispose: () => {
        admission.close();
        unobserve();
      },
    };
  }
  type Caller = Awaited<ReturnType<typeof caller>>;

  async function fixture(options?: { imageCapable?: true }) {
    // Pin current keyed roster and model through the shared fixture owner; these
    // scenarios must not depend on an implicit-main migration or catalog defaults.
    testState.agentsConfig = { entries: { main: {} } };
    testState.agentConfig = { model: { primary: "anthropic/claude-opus-4-6" } };
    if (options?.imageCapable) {
      // Use the existing Gateway integration catalog setup, not a mocked
      // capability decision or a media-writer replacement. Inference stays mocked.
      const [{ refreshPreparedModelRuntimeSnapshots }, config] = await Promise.all([
        import("../agents/prepared-model-runtime.js"),
        import("../config/io.js"),
      ]);
      await resetPreparedModelCatalogStateForTest();
      await config.writeConfigFile({
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://anthropic.example.test/v1",
              models: [
                {
                  id: "claude-opus-4-6",
                  name: "Proof image fixture",
                  input: ["text", "image"],
                  reasoning: false,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128_000,
                  maxTokens: 8_192,
                },
              ],
            },
          },
        },
      });
      config.clearRuntimeConfigSnapshot();
      await refreshPreparedModelRuntimeSnapshots(config.getRuntimeConfig(), {
        gatewayLifecycle: true,
      });
    }
    await prepareGatewayReplyRuntimeForTest();
    if (options?.imageCapable) {
      const context = kernel.gatewayRequestContext;
      const imageCapable = await resolveGatewayModelSupportsImages({
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
        loadGatewayModelCatalogSnapshot: context.loadGatewayModelCatalogSnapshot,
        agentId: "main",
        provider: "anthropic",
        model: "claude-opus-4-6",
      });
      observe("media-setup", { imageCapable });
      expect(imageCapable).toBe(true);
    }
    const context = kernel.gatewayRequestContext;
    const runId = randomUUID();
    const sessionKey = "agent:main:authority-proof:" + runId;
    const sessionId = "proof-session-" + runId;
    await sessionAccessor.upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId, updatedAt: Date.now() },
    );
    const scope = {
      agentId: "main",
      sessionKey,
      sessionId,
      storePath: loadSessionEntry(sessionKey, { agentId: "main" }).storePath,
    };
    await sessionAccessor.appendTranscriptMessage(scope, {
      message: { role: "user", content: "prior transcript sentinel", timestamp: Date.now() },
    });
    const before = sessionAccessor.loadTranscriptEventsSync(scope);
    const parentKey = "agent:main:authority-parent:" + runId;
    const owner = await caller(parentKey);
    const owners = [owner];
    const work = new Set<Promise<unknown>>();
    const track = context.trackExecution.bind(context);
    const observer = vi
      .spyOn(context, "trackExecution")
      .mockImplementation(<T>(operation: () => T | Promise<T>): Promise<T> => {
        const pending = track(operation);
        work.add(pending);
        void pending.then(
          () => work.delete(pending),
          () => work.delete(pending),
        );
        return pending;
      });
    const drain = async () => {
      while (work.size) {
        await Promise.allSettled(work);
      }
    };
    return {
      context,
      runId,
      sessionKey,
      sessionId,
      scope,
      before,
      owner,
      freshCaller: async () => {
        const fresh = await caller(parentKey);
        owners.push(fresh);
        expect(fresh.authority.claimId).not.toBe(owner.authority.claimId);
        expect(fresh.identity.operationalRunInstance.instanceId).not.toBe(
          owner.identity.operationalRunInstance.instanceId,
        );
        return fresh;
      },
      // Raw dispatch goes through the registered RPC handler, not the internal
      // agent facade. No test-supplied commit guard can mask the production fix.
      // A null source omits the private identity for ordinary-call compatibility.
      dispatch: (request: Record<string, unknown>, source: Caller | null = owner) => {
        const pending = dispatchGatewayMethodInProcessRaw(
          "agent",
          {
            sessionKey,
            idempotencyKey: runId,
            ...request,
          },
          withInProcessAgentRuntimeIdentity(
            {
              forceSyntheticClient: true,
              syntheticScopes: ["operator.admin"],
              resolveGatewayContext: () => context,
            },
            source?.identity,
          ),
        );
        void pending.catch(() => {});
        return pending;
      },
      effects: (): ProofObservation => ({
        ...owner.observation(),
        pendingCount: listSessionPendingInputs(scope).total,
        transcriptChanged: !isDeepStrictEqual(
          sessionAccessor.loadTranscriptEventsSync(scope),
          before,
        ),
      }),
      drain,
      cleanup: async () => {
        try {
          await drain();
        } finally {
          observer.mockRestore();
          for (const source of owners) {
            source.dispose();
          }
        }
      },
    };
  }

  return fixture;
}

export async function holdExecution(signal: AbortSignal) {
  const module = await import("./agent-turn/agent-run-execution-phase.js");
  const execute = module.startAgentRunExecution;
  const entered = createDeferred<PreparedAgentRunDispatch>();
  const release = createDeferred();
  const releaseWait = () => release.resolve();
  signal.addEventListener("abort", releaseWait, { once: true });
  if (signal.aborted) {
    releaseWait();
  }
  let execution: Promise<void> | undefined;
  const observer = vi.spyOn(module, "startAgentRunExecution").mockImplementationOnce((params) => {
    entered.resolve(params.prepared);
    execution = release.promise.then(() => execute(params));
    void execution.catch(() => {});
    return execution;
  });
  return {
    entered: entered.promise,
    observer,
    cleanup: async () => {
      release.resolve();
      await Promise.allSettled([execution]);
      observer.mockRestore();
      signal.removeEventListener("abort", releaseWait);
    },
  };
}

export async function createResetDeliveryFixture(
  fixture: ReturnType<typeof installAgentAuthorityProofFixture>,
  options: { beforeSendAttempt?: () => Promise<void>; failSend?: boolean } = {},
) {
  let deliveryAttempts = 0;
  const plugin: ChannelPlugin = {
    ...createOutboundTestPlugin({
      id: "matrix",
      outbound: {
        deliveryMode: "direct",
        sendText: async () => {
          throw new Error("message adapter must own final I/O");
        },
      },
    }),
    message: {
      id: "matrix",
      durableFinal: { capabilities: { text: true } },
      send: {
        lifecycle: {
          beforeSendAttempt: async () => {
            deliveryAttempts++;
            await options.beforeSendAttempt?.();
          },
        },
        text: async ({ text, onPlatformSendDispatch, assertDirectAdapterHandoff }) => {
          await onPlatformSendDispatch?.();
          assertDirectAdapterHandoff?.();
          if (options.failSend) {
            throw new Error("proof strict reset delivery failure");
          }
          if (!sink) {
            throw new Error("recording sink not prepared");
          }
          await fs.appendFile(sink, text + "\n");
          return {
            messageId: "proof-reset",
            receipt: createMessageReceiptFromOutboundResults({
              results: [{ channel: "matrix", messageId: "proof-reset" }],
              kind: "text",
            }),
          };
        },
      },
    },
  };
  const registry = getTestPluginRegistry();
  const recording = createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]);
  setTestPluginRegistry({
    ...registry,
    channels: [
      ...registry.channels.filter((entry) => entry.pluginId !== "matrix"),
      ...recording.channels,
    ],
    channelSetups: [
      ...registry.channelSetups.filter((entry) => entry.pluginId !== "matrix"),
      ...recording.channelSetups,
    ],
  });
  const f = await fixture();
  const recordingAdapterRetained =
    getTestPluginRegistry().channels.find((entry) => entry.pluginId === "matrix")?.plugin ===
    plugin;
  const sink = path.join(path.dirname(f.scope.storePath), "reset-delivery-" + f.runId + ".txt");
  await fs.mkdir(path.dirname(sink), { recursive: true });
  return { f, sink, recordingAdapterRetained, attempts: () => deliveryAttempts };
}
