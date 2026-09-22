import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, expect, it, onTestFinished } from "vitest";
import { withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  claimAgentRunApprovalAuthority,
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createCompiledSdkHost } from "../../plugins/compiled-sdk-host.test-support.js";
import { registerComputerUseProvider } from "../../plugins/computer-use-contract.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { computerUseSdkEntrypoint } from "../../plugins/loader-sdk-bridge-artifacts.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
} from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-identity-token.js";
import { createGatewayAuxHandlers } from "../server-aux-handlers.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { computerHandlers } from "../server-methods/computer.js";
import type { RespondFn } from "../server-methods/types.js";
import { createGatewayComputerService } from "./computer-service.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["direct-run", "parent-closes-scope", "scope-closes"] as const)(
  "cancels %s authority after native input is queued in the real child and before its final effect",
  async (mode) => {
    const state = await createOpenClawTestState({ label: "computer-authority" });
    const entered = createDeferredCore<http.ServerResponse>();
    const blockerEntered = createDeferredCore();
    const revokedQueued = createDeferredCore();
    const revokedCancelled = createDeferredCore();
    const gate = http.createServer((request, response) => {
      if (request.url === "/gate/allowed") {
        entered.resolve(response);
        return;
      }
      if (request.url === "/gate/blocker") {
        blockerEntered.resolve();
        return;
      }
      if (request.url === "/queued/revoked") {
        revokedQueued.resolve();
      }
      if (request.url === "/cancelled/revoked") {
        revokedCancelled.resolve();
      }
      response.writeHead(204).end();
    });
    onTestFinished(async () => {
      gate.closeAllConnections();
      if (gate.listening) {
        await new Promise<void>((resolve, reject) => {
          gate.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await state.cleanup();
    });
    await new Promise<void>((resolve, reject) => {
      gate.once("error", reject);
      gate.listen(0, "127.0.0.1", resolve);
    });
    const address = gate.address();
    if (!address || typeof address === "string") {
      throw new Error("Native input gate did not acquire a loopback port");
    }
    const pluginId = "fixture-authority-computer";
    const pluginRoot = state.path("plugin");
    fs.mkdirSync(pluginRoot);
    const fixture = createColdPluginFixture({
      rootDir: pluginRoot,
      pluginId,
      manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
    });
    const events = state.path("native-events.txt");
    const allowedEffect = state.path("allowed-effect.txt");
    const revokedEffect = state.path("revoked-effect.txt");
    const blockerEffect = state.path("blocker-effect.txt");
    fs.writeFileSync(
      fixture.runtimeSource,
      `
const fs = require("node:fs");
const http = require("node:http");
const { registerComputerUseProvider } = require("openclaw/plugin-sdk/computer-use");
const record = (event) => fs.appendFileSync(${JSON.stringify(events)}, event + "\\n");
const effects = ${JSON.stringify({ allowed: allowedEffect, revoked: revokedEffect, blocker: blockerEffect })};
const request = (route, signal) => new Promise((resolve, reject) => {
  const req = http.get("http://127.0.0.1:${address.port}/" + route, { signal }, (response) => {
    response.resume();
    response.once("end", resolve);
    response.once("error", reject);
  });
  req.once("error", reject);
});
process.once("exit", (code) => record("exit:" + code));
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    registerComputerUseProvider(api, {
      id: ${JSON.stringify(pluginId)}, label: "Synthetic authority computer", isAvailable: () => true,
      capabilities: () => ({
        contractVersion: 2,
        provider: { id: ${JSON.stringify(pluginId)}, label: "Synthetic authority computer", generation: "authority-generation" },
        actions: ["screenshot", "type"], targets: ["screen"], deliveryModes: ["foreground"], observations: ["image"],
        features: { recording: false, agentCursor: false, multiDisplay: false },
      }),
      async openExecution() {
        let tail = Promise.resolve();
        return {
          async snapshot() { return JSON.stringify({ format: "png", base64: "c3ludGhldGlj" }); },
          async act(paramsJSON, signal) {
            if (!signal) throw new Error("Native input did not receive its cancellation lifetime");
            const label = JSON.parse(paramsJSON).text;
            if (!Object.hasOwn(effects, label)) throw new Error("Unexpected synthetic input");
            const prior = tail;
            const result = prior.then(async () => {
              try {
                signal.throwIfAborted();
                await request("gate/" + label, signal);
                signal.throwIfAborted();
                fs.writeFileSync(effects[label], "applied");
                record("effect:" + label);
                return JSON.stringify({ ok: true });
              } catch (error) {
                if (signal.aborted) {
                  record("cancelled:" + label);
                  await request("cancelled/" + label);
                }
                throw error;
              }
            });
            tail = result.catch(() => {});
            await request("queued/" + label);
            return await result;
          },
          async close(reason) { await tail; record("close:" + reason); },
        };
      },
    });
  },
};
`,
    );
    const config = createColdPluginConfig(pluginRoot, pluginId);
    config.plugins!.allow = [pluginId];
    config.desktop = { host: { enabled: true, managed: true } };
    await state.writeConfig(config);
    const sdkHost = createCompiledSdkHost(computerUseSdkEntrypoint, (prefix) =>
      tempDirs.make(prefix),
    );
    const env = {
      PATH: path.dirname(process.execPath),
      HOME: state.home,
      USERPROFILE: state.home,
      OPENCLAW_HOME: state.home,
      OPENCLAW_STATE_DIR: state.stateDir,
      OPENCLAW_CONFIG_PATH: state.configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      ...(sdkHost ? { OPENCLAW_DEV_SOURCE_ROOT: sdkHost } : {}),
      NODE_ENV: "test",
    };
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: pluginId,
        source: fixture.runtimeSource,
        origin: "config",
        enabled: true,
        configSchema: true,
      }),
    );
    registerComputerUseProvider(
      {
        registerNodeHostCommand: (command) =>
          registry.nodeHostCommands.push({
            pluginId,
            pluginName: "Synthetic authority computer",
            command,
            source: fixture.runtimeSource,
          }),
      },
      {
        id: pluginId,
        label: "Synthetic authority computer",
        isAvailable: () => true,
        capabilities: () => ({
          contractVersion: 2,
          provider: {
            id: pluginId,
            label: "Synthetic authority computer",
            generation: "authority-generation",
          },
          actions: ["screenshot", "type"],
          targets: ["screen"],
          deliveryModes: ["foreground"],
          observations: ["image"],
          features: { recording: false, agentCursor: false, multiDisplay: false },
        }),
        openExecution: async () => {
          throw new Error("Native execution must run in the child");
        },
      },
    );
    let desktopCurrent = true;
    const service = createGatewayComputerService({
      getConfig: () => config,
      getPluginRegistry: () => registry,
      hostDesktopService: {
        observe: async () => {
          throw new Error("Unexpected desktop observer");
        },
        status: async () => {
          throw new Error("Unexpected desktop status");
        },
        acquireComputer: async () => ({
          env,
          isCurrent: () => desktopCurrent,
          release: () => {
            desktopCurrent = false;
          },
        }),
      },
    });
    const parentAuthority = claimAgentRunDelegatedAuthority({
      instanceId: "computer-live-instance",
      runId: "computer-live-run",
    });
    const scopeLifetime = new AbortController();
    const authority =
      mode === "direct-run"
        ? parentAuthority
        : claimAgentRunApprovalAuthority(parentAuthority, [scopeLifetime.signal]);
    const unrelated = claimAgentRunApprovalAuthority(parentAuthority, [
      new AbortController().signal,
    ]);
    const aux = createGatewayAuxHandlers({
      log: {},
      getNativeApprovalRouteCoordinator: () => undefined,
      activateRuntimeSecrets: async () => {
        throw new Error("Unexpected secrets reload");
      },
      sharedGatewaySessionGenerationState: { current: undefined, required: null },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      clients: [],
      channelManager: {
        startChannel: async () => new Map(),
        stopChannel: async () => {},
        isManuallyStopped: () => false,
        resolveRuntimeAccountId: (_channel, accountId) => accountId,
      },
      logChannels: { info: () => {} },
      onAgentRunAuthorityClosed: (closed) => service.revokeRunAuthority(closed),
    });
    const validateAuthority = createAgentRuntimeApprovalAuthorityValidator();
    const requestLifetime = new AbortController();
    const pending: Promise<unknown>[] = [];
    const invoke = async (text: string) => {
      const params = {
        command: "computer.act",
        generation: "authority-generation",
        params: { action: "type", text, executionId: "123e4567-e89b-42d3-a456-426614174000" },
        idempotencyKey: text,
      };
      let response: Parameters<RespondFn> | undefined;
      await computerHandlers["computer.invoke"]!({
        req: { type: "req", id: text, method: "computer.invoke", params },
        params,
        signal: requestLifetime.signal,
        respond: (...args) => {
          response = args;
        },
        isWebchatConnect: () => false,
        client: {
          connId: "computer-agent-rpc",
          connect: {
            minProtocol: 1,
            maxProtocol: 1,
            client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
          },
          internal: {
            syntheticClient: true,
            agentRuntimeIdentity: {
              kind: "agentRuntime",
              agentId: "main",
              sessionKey: "agent:main:computer-proof",
              operationalRunInstance: authority.operationalRunInstance,
              delegatedAuthority: { ...authority, kind: "local" },
            },
          },
        },
        context: createDirectChatContext({
          gatewayComputerService: service,
          validateAgentRuntimeApprovalAuthority: validateAuthority,
        }),
      });
      expect(response).toBeDefined();
      return response!;
    };
    try {
      expect(await service.status()).toMatchObject({ configured: true, available: true });
      const allowed = invoke("allowed");
      pending.push(allowed);
      const releaseAllowed = await Promise.race([
        entered.promise,
        allowed.then(() => {
          throw new Error("Allowed native input never reached its gate");
        }),
      ]);
      releaseAgentRunDelegatedAuthority(unrelated);
      expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
      releaseAllowed.writeHead(204).end();
      expect((await allowed)[0]).toBe(true);
      expect(fs.readFileSync(allowedEffect, "utf8")).toBe("applied");

      const blocker = invoke("blocker");
      pending.push(blocker);
      await Promise.race([
        blockerEntered.promise,
        blocker.then(() => {
          throw new Error("Blocking native input never reached its gate");
        }),
      ]);
      const revoked = invoke("revoked");
      pending.push(revoked);
      await Promise.race([
        revokedQueued.promise,
        revoked.then(() => {
          throw new Error("Revoked native input never entered the child queue");
        }),
      ]);
      if (mode === "scope-closes") {
        scopeLifetime.abort();
        expect(validateAgentRunDelegatedAuthority(parentAuthority)).toBe(true);
      } else {
        expect(releaseAgentRunDelegatedAuthority(parentAuthority)).toBe(true);
      }
      expect(requestLifetime.signal.aborted).toBe(false);
      // Observe native cancellation before explicit cleanup or the 60-second RPC deadline.
      await withTestTimeout(
        revokedCancelled.promise,
        10_000,
        "Run revocation did not cancel queued native input",
      );
      await service.close();
      expect((await blocker)[0]).toBe(false);
      expect((await revoked)[0]).toBe(false);
      expect(fs.existsSync(blockerEffect)).toBe(false);
      expect(fs.existsSync(revokedEffect)).toBe(false);
      const nativeEvents = fs.readFileSync(events, "utf8");
      expect(nativeEvents).toContain("cancelled:blocker\n");
      expect(nativeEvents).toContain("cancelled:revoked\n");
      expect(nativeEvents).toContain("close:gateway-disconnect\n");
      expect(nativeEvents).toContain("exit:0\n");
      expect(desktopCurrent).toBe(false);
      console.log(
        `[computer-authority-proof] ${mode}: live input applied; sibling claim closure preserved owner; revoked queued input cancelled before effect; native child exit joined`,
      );
    } finally {
      releaseAgentRunDelegatedAuthority(authority);
      releaseAgentRunDelegatedAuthority(parentAuthority);
      releaseAgentRunDelegatedAuthority(unrelated);
      requestLifetime.abort();
      try {
        await service.close();
        await Promise.allSettled(pending);
      } finally {
        await aux.stopOperatorInteractions();
      }
    }
  },
  90_000,
);
