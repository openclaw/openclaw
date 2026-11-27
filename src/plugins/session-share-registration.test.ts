import "../test-utils/prepare-compiled-subprocesses.js";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveNodeCommandAllowlist } from "../gateway/node-command-policy.js";
import { nodeInvokeHandlers } from "../gateway/server-methods/nodes.invoke.js";
import { createNodeInvokeTestHarness } from "../gateway/server-methods/nodes.invoke.test-support.js";
import { captureNodePairingGeneration } from "../infra/device-pairing-node-state.js";
import { approveNodePairing, requestNodePairing } from "../infra/device-pairing-node.js";
import { seedNodeDevice } from "../infra/device-pairing-node.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadOpenClawPlugins } from "./loader.js";
import { tryNativeRequireModule } from "./native-module-require.js";
import { getActivePluginGatewayNodePolicyRegistry } from "./runtime-state.js";
import { preparePluginLoaderAliases } from "./sdk-alias.js";

afterEach(async () => {
  const runtime = await vi.importActual<typeof import("./runtime.js")>("./runtime.js");
  runtime.resetPluginRuntimeStateForTest();
});
const config: OpenClawConfig = {
  plugins: {
    allow: ["session-share"],
    entries: { "session-share": { enabled: true, config: { share: { groups: ["Team"] } } } },
  },
};
const legacy = ["openclaw.sessions.list.v1", "openclaw.sessions.read.v1"];
async function register() {
  const registry = loadOpenClawPlugins({
    cache: false,
    activate: false,
    config,
    onlyPluginIds: ["session-share"],
    env: { ...process.env, OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions") },
  });
  expect(registry.diagnostics).toEqual([]);
  const runtime = await vi.importActual<typeof import("./runtime.js")>("./runtime.js");
  runtime.setActivePluginRegistry(registry);
  expect(getActivePluginGatewayNodePolicyRegistry()).toBe(registry);
  return registry;
}
it("loads through the registrar with only the legacy pair default-allowed", async () => {
  const registry = await register();
  expect(registry.nodeInvokePolicies.map(({ policy }) => policy.commands)).toEqual([
    ["openclaw.sessions.catalog.list.v1", "openclaw.sessions.catalog.read.v1"],
    legacy,
  ]);
  expect(
    registry.nodeInvokePolicies.map(({ policy }) => ({
      defaults: policy.defaultPlatforms,
      dangerous: policy.dangerous,
    })),
  ).toEqual([
    { defaults: undefined, dangerous: undefined },
    { defaults: ["macos", "linux", "windows"], dangerous: undefined },
  ]);
  const commands = registry.nodeHostCommands.map(({ command }) => command.command);
  for (const [platform, deviceFamily] of [
    ["linux", "Linux"],
    ["macos", "Mac"],
    ["windows", "Windows"],
  ]) {
    const allowed = resolveNodeCommandAllowlist(
      {},
      { platform, deviceFamily, commands, approvedCommands: commands },
    );
    expect({
      platform,
      commands,
      matching: commands.filter((command) => allowed.has(command)),
    }).toEqual({ platform, commands, matching: legacy });
  }
});
it("invokes the real source list and read through the receiver's default policy", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await state.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    // The actual plugin loader owns a native module graph, as in production.
    const native = tryNativeRequireModule(path.resolve("src/config/io.ts"), {
      aliasMap: preparePluginLoaderAliases({
        modulePath: path.resolve("extensions/session-share/index.ts"),
        devSourceRoot: process.cwd(),
        pluginSdkResolution: "src",
      }).resolveAlias,
    });
    if (!native.ok) {
      throw new Error("Native config runtime was unavailable");
    }
    const sourceConfig = native.moduleExport as typeof import("../config/io.js");
    sourceConfig.setRuntimeConfigSnapshot(config, config);
    await sourceConfig.captureRuntimeConfigAsyncReader()();
    const registry = await register();
    const commands = registry.nodeHostCommands.map(({ command }) => command);
    const ids = commands.map(({ command }) => command);
    const nodeId = "synthetic-share-node";
    await seedNodeDevice(state.stateDir, nodeId);
    const pending = await requestNodePairing({ nodeId, platform: "linux", commands: ids });
    await approveNodePairing(pending.request.requestId, { callerScopes: ["operator.admin"] });
    const generation = await captureNodePairingGeneration(nodeId);
    expect(generation).not.toBeNull();
    const source = {
      nodeId,
      connId: "synthetic-source",
      platform: "linux",
      deviceFamily: "Linux",
      commands: ids,
      pairingGeneration: expectDefined(generation, "paired source").key,
      client: { invalidated: false },
    };
    await replaceSessionEntry(
      { agentId: "main", sessionKey: "agent:main:shared" },
      {
        sessionId: "shared",
        updatedAt: 1,
        category: "Team",
      },
    );
    const transport = vi.fn(async (request: { command: string; params?: unknown }) => {
      const command = expectDefined(
        commands.find((entry) => entry.command === request.command),
        "source command",
      );
      return {
        ok: true as const,
        payloadJSON: await command.handle(JSON.stringify(request.params)),
      };
    });
    const invoke = createNodeInvokeTestHarness({
      getRuntimeConfig: () => config,
      nodeHandlers: nodeInvokeHandlers,
    });
    for (const command of legacy) {
      const respond = await invoke({
        nodeRegistry: { get: () => source, invoke: transport },
        requestParams: {
          nodeId,
          command,
          // The Session Share receiver allows up to 30 s per invoke; the first source read
          // starts a cold session-history worker and can exceed the 5 s default here.
          timeoutMs: 30_000,
          params: command === legacy[1] ? { threadId: "agent:main:shared" } : {},
        },
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({ ok: true, nodeId, command }),
        undefined,
      );
      const payload = JSON.parse(
        expectDefined(respond.mock.calls[0], "source response")[1].payloadJSON,
      );
      expect(payload).toMatchObject(
        command === legacy[0]
          ? { sessions: [{ threadId: "agent:main:shared" }] }
          : { threadId: "agent:main:shared", items: [] },
      );
    }
    const denied = await invoke({
      nodeRegistry: { get: () => source, invoke: transport },
      requestParams: { nodeId, command: "openclaw.sessions.catalog.list.v1", params: {} },
    });
    expect(denied).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        details: expect.objectContaining({ reason: "command not allowlisted" }),
      }),
    );
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
