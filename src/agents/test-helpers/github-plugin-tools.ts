import type { OpenClawPluginToolContext } from "../../plugins/tool-types.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import type { resolveOpenClawPluginToolsForOptions } from "../openclaw-plugin-tools.js";
import type { OpenClawToolsOptions } from "../openclaw-tools.types.js";
import { preparePluginToolGatewayCapability } from "../plugin-tool-gateway.js";
import type { AnyAgentTool } from "../tools/common.js";
import type { InProcessGatewayCaller } from "../tools/in-process-gateway.js";

type Gateway = NonNullable<OpenClawPluginToolContext<2>["gateway"]>;
const {
  createGitHubIdentityStatusTool: createIdentityTool,
  createGitHubPublishTool: createPublishTool,
  githubPublishToolDefinition,
} = await loadBundledPluginFacade<{
  createGitHubIdentityStatusTool(gateway: Gateway): AnyAgentTool;
  createGitHubPublishTool(gateway: Gateway, options?: { preview?: true }): AnyAgentTool;
  githubPublishToolDefinition: Parameters<
    NonNullable<OpenClawPluginToolContext<2>["inheritToolPolicy"]>
  >[0];
}>({ pluginId: "github-repositories", artifactBasename: "runtime-api.ts" });
export { githubPublishToolDefinition };
const gatewayMethods = [
  "tools.github.status",
  "sessions.github.action",
  "sessions.github.publish",
  "sessions.github.readiness",
];
export type ResolveOpenClawPluginToolFixtureOptions = Parameters<
  typeof resolveOpenClawPluginToolsForOptions
>[0];

/** Existing Gateway integration fixtures now enter the plugin through the real host capability. */
export function createGitHubPublishTool(
  options: Pick<OpenClawToolsOptions, "sandbox" | "sessionId" | "runId" | "onYield"> & {
    publicationAvailable?: boolean;
    actionsAvailable?: boolean;
    preview?: true;
  } = {},
) {
  const gateway = preparePluginToolGatewayCapability(
    { ...options, githubPublicationAvailable: options.publicationAvailable ?? true },
    {},
  )(() => {}, undefined, gatewayMethods);
  return createPublishTool(
    {
      get agentId() {
        return gateway.agentId;
      },
      get sessionKey() {
        return gateway.sessionKey;
      },
      clientCaps: gateway.clientCaps,
      call: gateway.call,
      handoff: gateway.handoff,
      idempotencyKey: gateway.idempotencyKey,
      workspace: {
        ...gateway.workspace,
        controlAvailable: options.actionsAvailable === true,
      },
    },
    options.preview ? { preview: true } : undefined,
  );
}

export function createGitHubIdentityStatusTool(
  options: { callGateway?: InProcessGatewayCaller; clientCaps?: string[] } = {},
) {
  const gateway = preparePluginToolGatewayCapability({ clientCaps: options.clientCaps }, {})(
    () => {},
    undefined,
    gatewayMethods,
  );
  return createIdentityTool({
    get agentId() {
      return gateway.agentId;
    },
    get sessionKey() {
      return gateway.sessionKey;
    },
    clientCaps: gateway.clientCaps,
    call: options.callGateway ?? gateway.call,
    handoff: gateway.handoff,
    idempotencyKey: gateway.idempotencyKey,
    workspace: gateway.workspace,
  });
}
