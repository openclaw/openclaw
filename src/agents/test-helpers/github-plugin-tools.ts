import {
  createGitHubIdentityStatusTool as createIdentityTool,
  createGitHubPublishTool as createPublishTool,
} from "../../../extensions/github-repositories/runtime-api.js";
import type { resolveOpenClawPluginToolsForOptions } from "../openclaw-plugin-tools.js";
import type { OpenClawToolsOptions } from "../openclaw-tools.types.js";
import { preparePluginToolGatewayCapability } from "../plugin-tool-gateway.js";
import type { InProcessGatewayCaller } from "../tools/in-process-gateway.js";

export { githubPublishToolDefinition } from "../../../extensions/github-repositories/runtime-api.js";
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
