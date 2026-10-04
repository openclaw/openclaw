import { once } from "node:events";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { dispatchInboundMessageInternal } from "../auto-reply/dispatch.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import { loadSessionEntry, loadTranscriptEventsSync } from "../config/sessions/session-accessor.js";
import { initializeGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import {
  chatSendOwner,
  dashboardTitleScheduleMocks,
} from "./server.sessions.create.test-support.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils-store-lookup.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  rpcReq,
  testState,
} from "./test-helpers.js";
import { getTestPluginRegistry } from "./test-helpers.plugin-registry.js";

installGatewayTestHooks({ scope: "suite" });

it("retains committed initial turns through fencing and denies their final write after grant revocation", async () => {
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
  testState.gatewayAuth = undefined;
  const token = "initial-turn-source-fixture-token";
  const configIO = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
  await configIO.writeConfigFile({
    ...configIO.getRuntimeConfig(),
    gateway: { ...configIO.getRuntimeConfig().gateway, auth: { mode: "token", token } },
  });
  const gateway = await createGatewaySuiteHarness({ serverOptions: { bind: "loopback" } });
  const applyConfig = async (config: Parameters<typeof configIO.writeConfigFile>[0]) => {
    const application = createRuntimeConfigWriteApplication();
    await configIO.writeConfigFile(config, attachRuntimeConfigWriteApplication({}, application));
    expect(application.claimed).toBe(true);
    expect(await application.result).toBe("applied");
  };
  const cases = ["retained", "revoked"].map((name) => {
    const key = `agent:main:dashboard:initial-source-${name}`;
    const { storePath } = resolveGatewaySessionStoreTarget({
      cfg: configIO.getRuntimeConfig(),
      agentId: "main",
      key,
    });
    return {
      key,
      scope: { agentId: "main", sessionKey: key, storePath },
      beforeTurn: createDeferredCore<GatewayRequestHandlerOptions>(),
      finishTurn: createDeferredCore(),
      allowWrite: createDeferredCore(),
      dispatchEntered: createDeferredCore(),
      dispatchFinished: createDeferredCore(),
      provider: vi.fn(),
      writeAttempt: vi.fn(),
      turnEntered: false,
      dispatchStarted: false,
    };
  });
  const resumeTurns = createDeferredCore();
  const originalSend = chatSendOwner.handleDirectExternalChatSend;
  const send = vi
    .spyOn(chatSendOwner, "handleDirectExternalChatSend")
    .mockImplementation(async (options) => {
      const scenario = cases.find(({ key }) => key === options.params.sessionKey);
      assert(scenario);
      scenario.turnEntered = true;
      scenario.beforeTurn.resolve(options);
      await resumeTurns.promise;
      try {
        await originalSend(options);
      } finally {
        scenario.finishTurn.resolve();
      }
    });
  dashboardTitleScheduleMocks.schedule.mockImplementation(() => {});
  const registry = getTestPluginRegistry();
  const hook: (typeof registry.typedHooks)[number] = {
    pluginId: "initial-turn-source-fixture",
    hookName: "before_message_write",
    source: "test",
    // Keep input pending until the real approval writer promotes it before inference.
    handler: () => {},
  };
  registry.typedHooks.push(hook);
  initializeGlobalHookRunner(registry);
  dispatchInboundMessageMock.mockClear();
  dispatchInboundMessageMock.mockImplementation(
    async (params: Parameters<typeof dispatchInboundMessageInternal>[0]) => {
      const scenario = cases.find(({ key }) => key === params.ctx.SessionKey);
      assert(scenario);
      const recorder = params.replyOptions?.userTurnTranscriptRecorder;
      assert(recorder);
      scenario.dispatchStarted = true;
      scenario.dispatchEntered.resolve();
      await scenario.allowWrite.promise;
      try {
        scenario.writeAttempt();
        if (await recorder.persistApproved()) {
          scenario.provider();
        }
        return {};
      } finally {
        scenario.dispatchFinished.resolve();
      }
    },
  );
  const sockets: Awaited<ReturnType<typeof gateway.openWs>>[] = [];
  const requests: Promise<unknown>[] = [];
  const waitForRelease = (scenario: (typeof cases)[number]) =>
    getSessionWorkAdmissionRelease({ scope: scenario.scope.storePath, identities: [scenario.key] });
  try {
    await gateway.server.startupSettled;
    for (const scenario of cases) {
      const ws = await gateway.openWs({ origin: `http://127.0.0.1:${gateway.port}` });
      sockets.push(ws);
      await connectOk(ws, {
        token,
        scopes: ["operator.admin"],
        client: { id: "openclaw-control-ui", version: "test", platform: "web", mode: "webchat" },
      });
      const request = rpcReq(ws, "sessions.create", {
        key: scenario.key,
        agentId: "main",
        task: "Start the accepted initial turn.",
      }).catch((error: unknown) => ({ error }));
      requests.push(request);
      const initial = await Promise.race([
        scenario.beforeTurn.promise,
        request.then((result) => {
          throw new Error(`create returned before its initial turn: ${JSON.stringify(result)}`);
        }),
      ]);
      expect(initial.client?.authenticatedUserProfile?.profileId).toBe(GATEWAY_OWNER_PROFILE_ID);
      expect(loadSessionEntry(scenario.scope)?.sessionId).toBeTruthy();
    }
    const closed = sockets.map((ws) => once(ws, "close"));
    const current = configIO.getRuntimeConfig();
    await applyConfig({
      ...current,
      gateway: { ...current.gateway, allowRealIpFallback: !current.gateway?.allowRealIpFallback },
    });
    for (const close of closed) {
      const [code, reason] = await close;
      expect(code).toBe(4001);
      expect(String(reason)).toBe("gateway policy changed");
    }
    resumeTurns.resolve();
    for (const scenario of cases) {
      await scenario.finishTurn.promise;
      await Promise.race([
        scenario.dispatchEntered.promise,
        Promise.resolve(waitForRelease(scenario)).then(() => {
          throw new Error("initial turn retired before dispatch");
        }),
      ]);
    }
    for (const scenario of cases) {
      const revoke = scenario === cases[1];
      if (revoke) {
        const config = configIO.getRuntimeConfig();
        await applyConfig({
          ...config,
          gateway: {
            ...config.gateway,
            auth: { mode: "token", token: "initial-turn-revoked-fixture-token" },
          },
        });
      }
      scenario.allowWrite.resolve();
      await scenario.dispatchFinished.promise;
      await waitForRelease(scenario);
      expect(scenario.writeAttempt).toHaveBeenCalledOnce();
      expect(scenario.provider).toHaveBeenCalledTimes(revoke ? 0 : 1);
      const entry = loadSessionEntry(scenario.scope);
      assert(entry?.sessionId);
      const userMessages = loadTranscriptEventsSync({
        ...scenario.scope,
        sessionId: entry.sessionId,
      }).filter(
        (event) =>
          isRecord(event) &&
          event.type === "message" &&
          isRecord(event.message) &&
          event.message.role === "user",
      );
      expect(userMessages).toHaveLength(revoke ? 0 : 1);
      console.info(
        `[initial-turn-grant] session=${scenario.key} outcome=${revoke ? "denied (transcript absent)" : "accepted (transcript written)"}`,
      );
    }
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
  } finally {
    resumeTurns.resolve();
    for (const scenario of cases) {
      scenario.allowWrite.resolve();
      if (scenario.turnEntered) {
        await scenario.finishTurn.promise;
      }
      if (scenario.dispatchStarted) {
        await scenario.dispatchFinished.promise;
      }
      await waitForRelease(scenario);
    }
    await Promise.all(requests);
    for (const ws of sockets) {
      ws.terminate();
    }
    send.mockRestore();
    const index = registry.typedHooks.indexOf(hook);
    if (index !== -1) {
      registry.typedHooks.splice(index, 1);
    }
    initializeGlobalHookRunner(registry);
    await gateway.close();
  }
});
