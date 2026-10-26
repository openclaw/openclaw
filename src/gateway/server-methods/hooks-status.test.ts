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
  const methodRegistry = createGatewayMethodRegistry(
    createCoreGatewayMethodDescriptors(hooksStatusHandlers),
    registry,
  );
  return {
    workspaceDir,
    dispatch: (
      requestParams = {},
      config: OpenClawConfig = { agents: { defaults: { workspace: workspaceDir } } },
      scopes = ["operator.read"],
    ) =>
      sendAuthorizationRequest("hooks.status", requestParams, {
        scopes,
        connId: "hooks-status-client",
        context: { getRuntimeConfig: () => config },
        methodRegistry,
      }),
  };
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

  const missing = await fixture.dispatch({}, config);
  expectRpcError(missing, { code: "INVALID_REQUEST", message: expect.stringContaining("agent") });

  const selected = await fixture.dispatch({ agentId: "research" }, config);
  expectRpcResult(selected, expect.objectContaining({ workspaceDir }));
});

it("returns registered plugin hooks from the request-attached live registry", async () => {
  const fixture = createHookRegistry();
  setActivePluginRegistry(createEmptyPluginRegistry());

  const respond = await fixture.dispatch();

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

  const denied = await fixture.dispatch({}, undefined, []);
  expect(denied).toHaveBeenCalledWith(false, undefined, {
    code: "FORBIDDEN",
    message: "missing scope: operator.read",
    details: {
      code: "MISSING_SCOPE",
      missingScope: "operator.read",
      requiredScopes: ["operator.read"],
    },
  });

  const invalid = await fixture.dispatch({ reload: true });
  expectRpcError(invalid, { code: "INVALID_REQUEST" });
});
