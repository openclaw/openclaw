import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createCoreGatewayMethodDescriptors } from "../methods/core-method-policy.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { sendAuthorizationRequest } from "../server-methods.authorization.test-support.js";
import { hooksStatusHandlers } from "./hooks-status.js";
import { expectRpcError, expectRpcResult } from "./rpc-response.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => setActivePluginRegistry(createEmptyPluginRegistry()));

function createHookRegistry() {
  const workspaceDir = tempDirs.make("openclaw-hooks-status-");
  const registry = createEmptyPluginRegistry();
  registry.hooks.push({
    pluginId: "live-hooks",
    source: "/plugins/live-hooks/index.js",
    events: ["command:new"],
    entry: {
      hook: {
        name: "live-plugin-hook",
        description: "Registered by the live Gateway plugin registry",
        source: "openclaw-plugin",
        pluginId: "live-hooks",
        filePath: "/plugins/live-hooks/index.js",
        baseDir: "/plugins/live-hooks",
        handlerPath: "/plugins/live-hooks/index.js",
      },
      frontmatter: {},
      metadata: { events: ["command:new"] },
      invocation: { enabled: true },
    },
  });
  return {
    workspaceDir,
    config: { agents: { defaults: { workspace: workspaceDir } } },
    methodRegistry: createGatewayMethodRegistry(
      createCoreGatewayMethodDescriptors(hooksStatusHandlers),
      registry,
    ),
  };
}

function dispatchHooksStatus(params: {
  methodRegistry: ReturnType<typeof createGatewayMethodRegistry>;
  config: OpenClawConfig;
  scopes?: string[];
  requestParams?: Record<string, unknown>;
}) {
  return sendAuthorizationRequest("hooks.status", params.requestParams ?? {}, {
    scopes: params.scopes ?? ["operator.read"],
    connId: "hooks-status-client",
    context: { getRuntimeConfig: () => params.config },
    methodRegistry: params.methodRegistry,
  });
}

it("returns typed selection-required for an ownerless explicit fleet", async () => {
  const fixture = createHookRegistry();
  const { workspaceDir } = fixture;
  const config: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: { workspace: workspaceDir },
      entries: { ops: {}, research: { workspace: workspaceDir } },
    },
  };

  const missing = await dispatchHooksStatus({ ...fixture, config });
  expectRpcError(missing, { code: "INVALID_REQUEST", message: expect.stringContaining("agent") });

  const selected = await dispatchHooksStatus({
    ...fixture,
    config,
    requestParams: { agentId: "research" },
  });
  expectRpcResult(selected, expect.objectContaining({ workspaceDir }));
});

it("returns registered plugin hooks from the request-attached live registry", async () => {
  const fixture = createHookRegistry();
  setActivePluginRegistry(createEmptyPluginRegistry());

  const respond = await dispatchHooksStatus(fixture);

  expectRpcResult(
    respond,
    expect.objectContaining({
      workspaceDir: fixture.workspaceDir,
      hooks: expect.arrayContaining([
        expect.objectContaining({
          name: "live-plugin-hook",
          pluginId: "live-hooks",
          managedByPlugin: true,
        }),
      ]),
    }),
  );
});

it("requires operator.read and rejects unexpected params", async () => {
  const fixture = createHookRegistry();

  const denied = await dispatchHooksStatus({ ...fixture, scopes: [] });
  expect(denied).toHaveBeenCalledWith(false, undefined, {
    code: "FORBIDDEN",
    message: "missing scope: operator.read",
    details: {
      code: "MISSING_SCOPE",
      missingScope: "operator.read",
      requiredScopes: ["operator.read"],
    },
  });

  const invalid = await dispatchHooksStatus({
    ...fixture,
    requestParams: { reload: true },
  });
  expectRpcError(invalid, { code: "INVALID_REQUEST" });
});
