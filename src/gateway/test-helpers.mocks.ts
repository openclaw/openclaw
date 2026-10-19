import path from "node:path";
import { vi } from "vitest";
import { withReplyDispatcher } from "../auto-reply/dispatch-dispatcher.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import {
  agentCommandMock,
  cronIsolatedRun,
  embeddedRunMock,
  type GetReplyFromConfigFn,
  getGatewayTestHoistedState,
  agentDiscoveryMock,
  testTailnetIPv4,
  testTailscaleWhois,
  type RunBtwSideQuestionFn,
} from "./test-helpers.runtime-state.js";

const gatewayTestHoisted = getGatewayTestHoistedState();

function createEmbeddedRunMockExports() {
  const runtime = {
    compactEmbeddedAgentSession: (...args: unknown[]) =>
      embeddedRunMock.compactEmbeddedAgentSession(...args),
    abortEmbeddedAgentRun: (sessionId: string) => {
      embeddedRunMock.abortCalls.push(sessionId);
      return embeddedRunMock.activeIds.has(sessionId);
    },
    waitForNativeRunEnd: async (sessionId: string, timeoutMs?: number | null) => {
      if (timeoutMs === null) {
        embeddedRunMock.endWaitCalls.push(sessionId);
        return await new Promise<boolean>((resolve) => {
          embeddedRunMock.endWaiters.set(sessionId, resolve);
        });
      }
      embeddedRunMock.waitCalls.push(sessionId);
      const ended = embeddedRunMock.waitResults.get(sessionId) ?? true;
      if (ended) {
        embeddedRunMock.activeIds.delete(sessionId);
      }
      if (ended || embeddedRunMock.resolveEndBeforeTimeoutIds.delete(sessionId)) {
        embeddedRunMock.endWaiters.get(sessionId)?.(true);
      }
      return ended;
    },
  };
  return {
    compactEmbeddedAgentSession: runtime.compactEmbeddedAgentSession,
    abortEmbeddedAgentRun: runtime.abortEmbeddedAgentRun,
    captureEmbeddedRunDrainTarget: (
      sessionId: string,
      owner: Parameters<
        typeof import("../agents/embedded-agent-runner/runs.js").captureEmbeddedRunDrainTarget
      >[1],
    ) =>
      embeddedRunMock.activeIds.has(sessionId)
        ? {
            sessionId,
            agentId: owner.agentId,
            sessionKey: undefined,
            isActive: () => embeddedRunMock.activeIds.has(sessionId),
            abort: () => runtime.abortEmbeddedAgentRun(sessionId),
            waitForEnd: (timeoutMs: number | null) =>
              runtime.waitForNativeRunEnd(sessionId, timeoutMs),
            release: () => {},
          }
        : undefined,
  };
}

async function embeddedMock<T extends object>(importOriginal: () => Promise<T>) {
  return { ...(await importOriginal()), ...createEmbeddedRunMockExports() };
}

type DispatchModule = typeof import("../auto-reply/dispatch.js");

function createDispatchInboundMessageMockExports(actual: DispatchModule): DispatchModule {
  const dispatch = gatewayTestHoisted.dispatchInboundMessage;
  type Result = ReturnType<DispatchModule["dispatchInboundMessage"]>;
  return {
    ...actual,
    dispatchInboundMessage: (params) =>
      dispatch.getMockImplementation()
        ? (dispatch(params) as Result)
        : actual.dispatchInboundMessage(params),
    dispatchInboundMessageWithProjectedDispatcher: (params) => {
      if (!dispatch.getMockImplementation()) {
        return actual.dispatchInboundMessageWithProjectedDispatcher(params);
      }
      const { dispatcherOptions, ...dispatchParams } = params;
      const dispatcher = createReplyDispatcher(dispatcherOptions);
      // The override bypasses dispatchInboundMessage's dispatcher lifecycle ownership.
      return withReplyDispatcher({
        dispatcher,
        run: () => dispatch({ ...dispatchParams, dispatcher }) as Result,
      });
    },
  };
}

async function dispatchMock(importOriginal: () => Promise<DispatchModule>) {
  return createDispatchInboundMessageMockExports(await importOriginal());
}
function btwMock() {
  return {
    runBtwSideQuestion: (...args: Parameters<RunBtwSideQuestionFn>) =>
      gatewayTestHoisted.runBtwSideQuestion(...args),
  };
}
function replyMock() {
  return {
    getReplyFromConfig: (...args: Parameters<GetReplyFromConfigFn>) =>
      gatewayTestHoisted.getReplyFromConfig(...args),
    prewarmConfigDrivenReplyRuntime: vi.fn(async () => {}),
  };
}

vi.mock("../agents/agent-model-discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/agent-model-discovery.js")>();
  const modelSessions = await vi.importActual<typeof import("../agents/sessions/index.js")>(
    "../agents/sessions/index.js",
  );

  return {
    ...actual,
    discoverModelsAsync: async (
      authStorage: Parameters<typeof actual.discoverModelsAsync>[0],
      agentDir: string,
    ) => {
      const registry = agentDiscoveryMock.enabled
        ? undefined
        : modelSessions.ModelRegistry.create(authStorage, path.join(agentDir, "models.json"));
      const read = (method: "getAll" | "getAvailable") => {
        if (!agentDiscoveryMock.enabled) {
          return registry?.[method]() ?? [];
        }
        if (method === "getAll") {
          agentDiscoveryMock.discoverCalls += 1;
        }
        return agentDiscoveryMock.models;
      };
      return {
        getAll: () => read("getAll"),
        getAvailable: () => read("getAvailable"),
        find: (provider: string, modelId: string) =>
          agentDiscoveryMock.enabled
            ? agentDiscoveryMock.models.find(
                (model) => model.provider === provider && model.id === modelId,
              )
            : registry?.find(provider, modelId),
      };
    },
  };
});

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: cronIsolatedRun,
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: () => testTailnetIPv4.value,
  pickPrimaryTailnetIPv6: () => undefined,
}));

vi.mock("../infra/tailscale.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/tailscale.js")>()),
  readTailscaleWhoisIdentity: async (
    ip: string,
    _exec: unknown,
    opts?: { timeoutMs?: number; cacheTtlMs?: number; errorTtlMs?: number },
  ) => {
    testTailscaleWhois.calls.push({ ip, opts });
    return testTailscaleWhois.value;
  },
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  const { createGatewayConfigOverrides } = await import("./test-helpers.config-runtime.js");
  return Object.defineProperties(
    { ...actual },
    Object.getOwnPropertyDescriptors(createGatewayConfigOverrides(actual)),
  );
});

vi.mock("../config/io.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/io.js")>();
  // The config facade re-exports IO; waiting for it here can deadlock a fresh module graph.
  const { createGatewayConfigOverrides } = await import("./test-helpers.config-runtime.js");
  const configMock = createGatewayConfigOverrides(actual);
  const ioOverrides = {
    getRuntimeConfig: configMock.getRuntimeConfig,
    readConfigFileSnapshot: configMock.readConfigFileSnapshot,
    readConfigFileSnapshotWithPluginMetadata: configMock.readConfigFileSnapshotWithPluginMetadata,
    readConfigFileSnapshotForWrite: configMock.readConfigFileSnapshotForWrite,
    writeConfigFile: configMock.writeConfigFile,
  };
  return {
    ...actual,
    ...ioOverrides,
    createConfigIO: vi.fn(() => ({ ...actual.createConfigIO(), ...ioOverrides })),
  };
});

vi.mock("../agents/embedded-agent.js", embeddedMock);
vi.mock("/src/agents/embedded-agent.js", embeddedMock);
vi.mock("../agents/embedded-agent-runner/runs.js", embeddedMock);
vi.mock("/src/agents/embedded-agent-runner/runs.js", embeddedMock);

// mock-isolation: Gateway fixtures must not collect real channel or session state.
vi.mock("./health/collector.js", () => ({
  collectGatewayHealthSnapshot: vi
    .fn<typeof import("./health/collector.js").collectGatewayHealthSnapshot>()
    .mockImplementation(async () => ({
      ok: true,
      ts: 0,
      durationMs: 0,
      channels: {},
      channelOrder: [],
      channelLabels: {},
      heartbeatSeconds: 0,
      agents: [],
      sessions: { path: "/test/gateway/sessions", count: 0, recent: [] },
    })),
}));
// mock-isolation: Gateway fixtures own their status response and must not collect local state.
vi.mock("../status/summary.js", () => ({
  getStatusSummary: vi.fn().mockResolvedValue({ ok: true }),
  prepareStatusSummary: vi.fn().mockResolvedValue({ publish: () => ({ summary: { ok: true } }) }),
}));
vi.mock("../commands/agent.js", () => ({
  agentCommand: agentCommandMock,
  agentCommandFromGatewayIngress: agentCommandMock,
  agentCommandFromIngress: agentCommandMock,
}));
vi.mock("../agents/btw.js", btwMock);
vi.mock("/src/agents/btw.js", btwMock);
vi.mock("../auto-reply/dispatch.js", dispatchMock);
vi.mock("/src/auto-reply/dispatch.js", dispatchMock);
vi.mock("../auto-reply/reply/get-reply-from-config.runtime.js", replyMock);
vi.mock("/src/auto-reply/reply/get-reply-from-config.runtime.js", replyMock);
vi.mock("../cli/deps.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/deps.js")>();
  const base = actual.createDefaultDeps();
  return {
    ...actual,
    createDefaultDeps: () => ({
      ...base,
      whatsapp: (...args: unknown[]) =>
        (gatewayTestHoisted.sendWhatsAppMock as (...args: unknown[]) => unknown)(...args),
    }),
  };
});

vi.mock("../plugins/loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/loader.js")>()),
  loadOpenClawPlugins: () => getTestPluginRegistry(),
}));
vi.stubEnv("OPENCLAW_SKIP_CHANNELS", "1");
vi.stubEnv("OPENCLAW_SKIP_CRON", "1");
