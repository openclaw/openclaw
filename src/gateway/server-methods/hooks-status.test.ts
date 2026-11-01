import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createCustomHook } from "../../plugins/status.test-fixtures.js";
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
  registry.hooks.push(
    createCustomHook({ pluginId: "live-hooks", name: "live-plugin-hook", events: ["command:new"] }),
  );
  const methodRegistry = createGatewayMethodRegistry(
    createCoreGatewayMethodDescriptors(hooksStatusHandlers),
    registry,
  );
  const config = {
    agents: {
      ownership: "explicit" as const,
      defaults: { workspace: workspaceDir },
      entries: { ops: {}, research: { workspace: workspaceDir } },
    },
  };
  const legacyConfig = { agents: { defaults: { workspace: workspaceDir } } };
  return {
    workspaceDir,
    dispatch: (
      requestParams: Record<string, unknown> = { agentId: "research" },
      scopes = ["operator.read"],
      legacy = false,
    ) =>
      sendAuthorizationRequest("hooks.status", requestParams, {
        scopes,
        connId: "hooks-status-client",
        context: { getRuntimeConfig: () => (legacy ? legacyConfig : config) },
        methodRegistry,
      }),
  };
}

it("requires agent selection and returns hooks from the selected request-attached registry", async () => {
  const fixture = createHookRegistry();
  setActivePluginRegistry(createEmptyPluginRegistry());
  expectRpcError(await fixture.dispatch({}), {
    code: "INVALID_REQUEST",
    message: expect.stringContaining("agent"),
  });
  const hook = expect.objectContaining({
    name: "live-plugin-hook",
    pluginId: "live-hooks",
    managedByPlugin: true,
  });
  expectRpcResult(
    await fixture.dispatch(),
    expect.objectContaining({
      workspaceDir: fixture.workspaceDir,
      hooks: expect.arrayContaining([hook]),
    }),
  );
  expectRpcResult(
    await fixture.dispatch({}, undefined, true),
    expect.objectContaining({ workspaceDir: fixture.workspaceDir }),
  );
});

it("requires operator.read and rejects unexpected params", async () => {
  const fixture = createHookRegistry();

  const denied = await fixture.dispatch(undefined, []);
  expectRpcError(denied, {
    code: "FORBIDDEN",
    details: expect.objectContaining({ missingScope: "operator.read" }),
  });

  expectRpcError(await fixture.dispatch({ reload: true }), { code: "INVALID_REQUEST" });
});
