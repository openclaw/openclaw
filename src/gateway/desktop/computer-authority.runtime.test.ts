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
import { registerComputerUseProvider } from "../../plugins/computer-use-registration.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { computerUseSdkEntrypoint } from "../../plugins/loader-sdk-bridge-artifacts.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  createColdPluginConfig,
  createColdPluginFixture,
} from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import { createGatewayAuxHandlers } from "../server-aux-handlers.js";
import { createGatewayAuxHandlerTestParams } from "../server-aux-handlers.test-support.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { computerHandlers } from "../server-methods/computer.js";
import type { RespondFn } from "../server-methods/types.js";
import { startComputerHostProcess } from "./computer-process.js";
import { createGatewayComputerService } from "./computer-service.js";
import { computerCapabilities } from "./computer.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createRuntimeFixture(pluginId: string, managed = false) {
  const state = await createOpenClawTestState({ label: pluginId, applyEnv: managed });
  const pluginRoot = state.path("plugin");
  fs.mkdirSync(pluginRoot);
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId,
    manifest: { providers: [], channels: [], channelConfigs: {}, providerAuthChoices: [] },
  });
  const config = createColdPluginConfig(pluginRoot, pluginId);
  config.plugins!.allow = [pluginId];
  if (managed) {
    config.desktop = { host: { enabled: true, managed: true } };
  }
  await state.writeConfig(config);
  const sdkHost = createCompiledSdkHost([computerUseSdkEntrypoint], (prefix) =>
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
  return { state, fixture, config, env };
}

function reachGate<T>(gate: Promise<T>, invocation: Promise<unknown>, label: string) {
  return Promise.race([
    gate,
    invocation.then(() => {
      throw new Error(`${label} native input never reached its gate`);
    }),
  ]);
}

it.each(["direct-run", "parent-closes-scope", "scope-closes"] as const)(
  "cancels %s authority after native input is queued in the real child and before its final effect",
  async (mode) => {
    const pluginId = "fixture-authority-computer";
    const { state, fixture, config, env } = await createRuntimeFixture(pluginId, true);
    const gates = {
      "/gate/allowed": createDeferredCore<http.ServerResponse>(),
      "/gate/blocker": createDeferredCore<http.ServerResponse>(),
      "/queued/revoked": createDeferredCore<http.ServerResponse>(),
      "/cancelled/revoked": createDeferredCore<http.ServerResponse>(),
    };
    const gate = http.createServer((request, response) => {
      Object.entries(gates)
        .find(([route]) => route === request.url)?.[1]
        .resolve(response);
      if (request.url !== "/gate/allowed" && request.url !== "/gate/blocker") {
        response.writeHead(204).end();
      }
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
    const capabilities = computerCapabilities(
      {
        id: pluginId,
        label: "Synthetic authority computer",
        generation: "authority-generation",
      },
      ["screenshot", "type"],
    );
    const events = state.path("native-events.txt");
    const effects = {
      allowed: state.path("allowed-effect.txt"),
      revoked: state.path("revoked-effect.txt"),
      blocker: state.path("blocker-effect.txt"),
    };
    fs.writeFileSync(
      fixture.runtimeSource,
      `
const fs = require("node:fs");
const http = require("node:http");
const { registerComputerUseProvider } = require("openclaw/plugin-sdk/computer-use");
const record = (event) => fs.appendFileSync(${JSON.stringify(events)}, event + "\\n");
const effects = ${JSON.stringify(effects)};
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
      capabilities: () => (${JSON.stringify(capabilities)}),
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
        capabilities: () => capabilities,
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
        reconcileRuntimePolicy: async () => {},
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
    const aux = createGatewayAuxHandlers(
      createGatewayAuxHandlerTestParams({
        onAgentRunAuthorityClosed: (closed) => service.revokeRunAuthority(closed),
      }),
    );
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
      const releaseAllowed = await reachGate(gates["/gate/allowed"].promise, allowed, "Allowed");
      releaseAgentRunDelegatedAuthority(unrelated);
      expect(validateAgentRunDelegatedAuthority(authority)).toBe(true);
      releaseAllowed.writeHead(204).end();
      expect((await allowed)[0]).toBe(true);
      expect(fs.readFileSync(effects.allowed, "utf8")).toBe("applied");

      const blocker = invoke("blocker");
      pending.push(blocker);
      await reachGate(gates["/gate/blocker"].promise, blocker, "Blocking");
      const revoked = invoke("revoked");
      pending.push(revoked);
      await reachGate(gates["/queued/revoked"].promise, revoked, "Revoked queued");
      if (mode === "scope-closes") {
        scopeLifetime.abort();
        expect(validateAgentRunDelegatedAuthority(parentAuthority)).toBe(true);
      } else {
        expect(releaseAgentRunDelegatedAuthority(parentAuthority)).toBe(true);
      }
      expect(requestLifetime.signal.aborted).toBe(false);
      // Observe native cancellation before explicit cleanup or the 60-second RPC deadline.
      await withTestTimeout(
        gates["/cancelled/revoked"].promise,
        10_000,
        "Run revocation did not cancel queued native input",
      );
      await service.close();
      expect((await blocker)[0]).toBe(false);
      expect((await revoked)[0]).toBe(false);
      expect(fs.existsSync(effects.blocker)).toBe(false);
      expect(fs.existsSync(effects.revoked)).toBe(false);
      const nativeEvents = fs.readFileSync(events, "utf8");
      expect(nativeEvents).toContain("cancelled:blocker\n");
      expect(nativeEvents).toContain("cancelled:revoked\n");
      expect(nativeEvents).toContain("close:gateway-disconnect\n");
      expect(nativeEvents).toContain("exit:0\n");
      expect(desktopCurrent).toBe(false);
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

it.each(["sync", "async", "reject"] as const)(
  "drains %s provider cleanup through the private worker before exiting",
  async (cleanupMode) => {
    const pluginId = "fixture-computer";
    const { state, fixture, env } = await createRuntimeFixture(pluginId);
    onTestFinished(() => state.cleanup());
    const provider = {
      id: pluginId,
      label: "Synthetic computer",
      generation: "fixture-generation",
    };
    const lifecycleFile = state.path("provider-lifecycle.txt");
    fs.writeFileSync(
      fixture.runtimeSource,
      `
const { appendFileSync } = require("node:fs");
const { registerComputerUseProvider } = require("openclaw/plugin-sdk/computer-use");
const record = (event) => appendFileSync(${JSON.stringify(lifecycleFile)}, event + "\\n");
process.once("exit", (code) => record("exit:" + code));
record("runtime:" + process.execPath);
module.exports = {
  id: ${JSON.stringify(pluginId)},
  register: (api) => registerComputerUseProvider(api, {
      id: ${JSON.stringify(pluginId)},
      label: "Synthetic computer",
      isAvailable: () => true,
      watchAvailability: () => () => {
        record("watch-stop:start");
        const finish = () => {
          record("watch-stop:done");
          if (${JSON.stringify(cleanupMode)} === "reject") {
            throw new Error("synthetic watcher cleanup failed");
          }
        };
        return ${JSON.stringify(cleanupMode)} === "sync"
          ? finish()
          : require("node:fs/promises").readFile(${JSON.stringify(lifecycleFile)}).then(finish);
      },
      capabilities: () => (${JSON.stringify(computerCapabilities(provider))}),
      async openExecution({ executionId, sessionKey }) {
        record("open:" + executionId);
        return {
          async snapshot() { return JSON.stringify({ format: "png", base64: "c3ludGhldGljLXBpeGVscw==" }); },
          async act(paramsJSON) {
            const params = JSON.parse(paramsJSON);
            return JSON.stringify({ ok: true, action: params.action, details: { executionId, sessionKey } });
          },
          async close(reason) { record("close:" + reason); },
        };
      },
    }),
};
`,
    );
    // A `node` earlier on PATH must not become the host worker runtime.
    const shimDir = state.path("shim");
    fs.mkdirSync(shimDir);
    const shimName = process.platform === "win32" ? "node.cmd" : "node";
    fs.writeFileSync(
      path.join(shimDir, shimName),
      process.platform === "win32" ? "@exit /b 42\r\n" : "#!/bin/sh\nexit 42\n",
      // Windows ignores the exec bit; POSIX needs it for the PATH scan to accept the shim.
      process.platform === "win32" ? {} : { mode: 0o755 },
    );
    const child = startComputerHostProcess({
      env: { ...env, PATH: `${shimDir}${path.delimiter}${path.dirname(process.execPath)}` },
      pluginIds: [pluginId],
      assertCurrent: () => {},
    });
    const executionId = "123e4567-e89b-42d3-a456-426614174000";
    const invocation = { sessionKey: "fixture-session", assertCurrent: () => {} };
    try {
      expect((await child.ready).provider).toEqual(provider);
      await expect(
        child.invoke({
          ...invocation,
          command: "screen.snapshot",
          params: { executionId },
        }),
      ).resolves.toEqual({ format: "png", base64: "c3ludGhldGljLXBpeGVscw==" });
      await expect(
        child.invoke({
          ...invocation,
          command: "computer.act",
          params: { executionId, action: "left_click", x: 1, y: 2 },
        }),
      ).resolves.toEqual({
        ok: true,
        action: "left_click",
        details: { executionId, sessionKey: "fixture-session" },
      });
    } finally {
      const closing = child.close({ executionId, reason: "completion" });
      if (cleanupMode === "reject") {
        await expect(closing).rejects.toThrow("Gateway computer helper shutdown failed");
      } else {
        await closing;
      }
    }
    expect(child.isCurrent()).toBe(false);
    expect(fs.readFileSync(lifecycleFile, "utf8").trim().split("\n")).toEqual([
      `runtime:${process.execPath}`,
      `open:${executionId}`,
      "close:completion",
      "watch-stop:start",
      "watch-stop:done",
      cleanupMode === "reject" ? "exit:1" : "exit:0",
    ]);
  },
  90_000,
);
