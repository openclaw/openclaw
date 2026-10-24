import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentHarness } from "../../agents/harness/types.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createSystemAgentPluginMetadataTestSnapshot } from "../../system-agent/system-agent.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { WizardSession } from "../../wizard/session.js";
import {
  acceptGatewayDeviceSourceAuthority,
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { createWizardSessionTracker } from "../server-wizard-sessions.js";
import {
  bindInProcessRequestMutationAuthority,
  captureGatewayRequestOperatorGuard,
} from "./session-mutation-guards.js";
import {
  createAdmittedWizardSession,
  whenAdmittedWizardSessionSettled,
} from "./setup-admission.js";
import { systemAgentHandlers } from "./system-agent.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const io = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  load: vi.fn(),
  settleBeforePublication: false,
}));
vi.mock("../../wizard/setup.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../wizard/setup.shared.js")>()),
  readSetupConfigFileSnapshot: io.read,
  writeWizardConfigFile: io.write,
}));
vi.mock("../../system-agent/setup-inference-turn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../system-agent/setup-inference-turn.js")>()),
  loadSetupInferencePluginGeneration: io.load,
}));
vi.mock("./setup-admission.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./setup-admission.js")>();
  return {
    ...actual,
    async createAdmittedWizardSession(
      ...args: Parameters<typeof actual.createAdmittedWizardSession>
    ) {
      const session = await actual.createAdmittedWizardSession(...args);
      // Let the actual runner and target lock finish before publishing its start reply.
      if (io.settleBeforePublication && session) {
        await actual.whenAdmittedWizardSessionSettled(session);
      }
      return session;
    },
  };
});

afterEach(() => {
  io.settleBeforePublication = false;
  vi.resetAllMocks();
});

function fixture() {
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: { nativeRuntimeConsent: ["fixture-runtime"] } },
    },
    plugins: { entries: { fixture: { config: { enabled: false } } } },
  };
  const registry = createEmptyPluginRegistry();
  const harness: AgentHarness = {
    id: "fixture-runtime",
    label: "Fixture Native",
    executionEnvironment: "host-only",
    supports: () => ({ supported: true }),
    runAttempt: async () => {
      throw new Error("Runtime enablement must not invoke inference");
    },
  };
  registry.agentHarnesses.push({ pluginId: "fixture", source: "runtime", harness });
  const loaded = createDeferredCore();
  const continueSetup = createDeferredCore();
  io.read.mockResolvedValue({
    exists: true,
    valid: true,
    sourceConfig: config,
  } satisfies Partial<ConfigFileSnapshot>);
  io.load.mockImplementation(async () => {
    loaded.resolve();
    await continueSetup.promise;
    return {
      pluginRegistry: registry,
      metadataSnapshot: createSystemAgentPluginMetadataTestSnapshot(config).bindForConfig(config),
    };
  });
  io.write.mockImplementation(async (_config, options) => {
    options.writeOptions.assertCurrent();
    options.writeOptions.beforeCommit();
  });
  const context = createContext([], () => config);
  Object.assign(context, createWizardSessionTracker());
  const client = createOperatorClient({
    profileId: "runtime-operator",
    scopes: ["operator.admin"],
  });
  const connection = new AbortController();
  client.connectionSignal = connection.signal;
  const unsubscribe = vi.fn();
  const source = captureGatewayDeviceRevocation(
    context,
    { deviceId: "runtime-device", role: "operator" },
    () => true,
    connection.signal,
    { isCurrent: () => true, subscribe: () => unsubscribe },
  );
  expect(acceptGatewayDeviceSourceAuthority(source.isCurrent)).toBe(true);
  const sessionId = "runtime-authority";
  const params = {
    sessionId,
    agentId: "main",
    runtimeId: harness.id,
    configPatch: { plugins: { entries: { fixture: { config: { enabled: true } } } } },
  };
  const respond = vi.fn();
  const options: GatewayRequestHandlerOptions = {
    req: { type: "req", id: sessionId, method: "openclaw.setup.runtime.start", params },
    params,
    respond,
    client,
    context,
    isWebchatConnect: () => false,
    hasCurrentClientAuthority: source.isCurrent,
  };
  bindInProcessRequestMutationAuthority(options, undefined, undefined);
  captureGatewayRequestOperatorGuard(options);
  const start = () =>
    expectDefined(systemAgentHandlers[options.req.method], "runtime setup handler")(options);
  const cleanup = async () => {
    continueSetup.resolve();
    for (const session of context.wizardSessions.values()) {
      session.close(new Error("fixture cleanup"));
      await whenAdmittedWizardSessionSettled(session);
    }
    source.release();
  };
  return {
    client,
    connection,
    context,
    continueSetup,
    loaded,
    respond,
    sessionId,
    source,
    start,
    unsubscribe,
    cleanup,
  };
}

async function withStartedRuntime(
  run: (request: ReturnType<typeof fixture>, session: WizardSession) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const request = fixture();
    try {
      await request.start();
      expect(request.respond).toHaveBeenCalledWith(
        true,
        { sessionId: request.sessionId, done: false, status: "running" },
        undefined,
      );
      const session = expectDefined(
        request.context.wizardSessions.get(request.sessionId),
        "runtime wizard",
      );
      await Promise.race([
        request.loaded.promise,
        session.whenSettled().then(() => {
          throw new Error("Runtime setup settled before plugin generation preparation");
        }),
      ]);
      request.source.release();
      expect(request.source.isCurrent()).toBe(true);
      expect(request.unsubscribe).not.toHaveBeenCalled();
      await run(request, session);
      expect(request.source.isCurrent()).toBe(false);
      expect(request.unsubscribe).toHaveBeenCalledOnce();
    } finally {
      await request.cleanup();
    }
  });
}

async function expectRevokedRuntime(request: ReturnType<typeof fixture>, session: WizardSession) {
  request.continueSetup.resolve();
  await whenAdmittedWizardSessionSettled(session);
  expect(await session.next()).toMatchObject({
    done: true,
    status: "error",
    error: "Gateway requester authority changed",
  });
  expect(io.write).not.toHaveBeenCalled();
}

it("keeps the runtime effect under its retained grant after start", async () => {
  await withStartedRuntime(async (request, session) => {
    request.continueSetup.resolve();
    await whenAdmittedWizardSessionSettled(session);
    expect(await session.next()).toMatchObject({ done: true, status: "done" });
    expect(io.write).toHaveBeenCalledOnce();
    expect(io.write.mock.calls[0]?.[0].plugins.entries.fixture.config).toEqual({
      enabled: true,
    });
  });
});

it("rejects the runtime effect after device revocation", async () => {
  await withStartedRuntime(async (request, session) => {
    invalidateGatewayDeviceRevocation(request.context, "runtime-device", "operator");
    await expectRevokedRuntime(request, session);
  });
});

it("rejects the runtime effect after operator scope revocation", async () => {
  await withStartedRuntime(async (request, session) => {
    request.client.connect.scopes = ["operator.read"];
    await expectRevokedRuntime(request, session);
  });
});

it("publishes a runtime wizard that completed before its start reply", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const request = fixture();
    io.settleBeforePublication = true;
    request.continueSetup.resolve();
    try {
      await request.start();
      expect(request.respond).toHaveBeenCalledWith(
        true,
        { sessionId: request.sessionId, done: false, status: "running" },
        undefined,
      );
      const session = expectDefined(
        request.context.wizardSessions.get(request.sessionId),
        "completed runtime wizard",
      );
      expect(await session.next()).toMatchObject({ done: true, status: "done" });
      expect(io.write).toHaveBeenCalledOnce();
      request.source.release();
      expect(request.unsubscribe).toHaveBeenCalledOnce();
    } finally {
      await request.cleanup();
    }
  });
});

function expectSetupNotStarted(request: ReturnType<typeof fixture>) {
  expect(request.context.wizardSessions.size).toBe(0);
  expect(io.read).not.toHaveBeenCalled();
  expect(io.load).not.toHaveBeenCalled();
  expect(io.write).not.toHaveBeenCalled();
  request.source.release();
  expect(request.unsubscribe).toHaveBeenCalledOnce();
}

it("does not begin runtime setup when admission is busy", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const request = fixture();
    const finishOther = createDeferredCore();
    const other = expectDefined(
      await createAdmittedWizardSession(() => new WizardSession(async () => finishOther.promise)),
      "other setup wizard",
    );
    try {
      await request.start();
      expect(request.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          details: { code: "SETUP_ADMISSION_BUSY" },
        }),
      );
      expectSetupNotStarted(request);
    } finally {
      finishOther.resolve();
      await whenAdmittedWizardSessionSettled(other);
      await request.cleanup();
    }
  });
});

it("does not begin runtime setup when disconnected before admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const request = fixture();
    try {
      request.connection.abort(new Error("Connection closed before admission"));
      await expect(request.start()).rejects.toThrow("Connection closed before admission");
      expectSetupNotStarted(request);
    } finally {
      await request.cleanup();
    }
  });
});
