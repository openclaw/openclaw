import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDevInstallGitBranch } from "../infra/dev-install-branch.js";
import { resolveRuntimeServiceBuildId, resolveRuntimeServiceVersion } from "../version.js";
import {
  controlUiAvatarResolutionMeta,
  resolveGatewayAssistantAvatar,
} from "./assistant-avatar.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";
import { resolveControlUiBootstrapPresentation } from "./control-ui-bootstrap-presentation.js";
import type {
  ControlUiBootstrapConfig,
  ControlUiPluginFrameGrantAck,
} from "./control-ui-contract.js";
import type { ControlUiDocumentDiagnostics } from "./control-ui-document-diagnostics.js";
import type { GatewayHttpRequestAuthOptions } from "./http-request-authority.js";
import { authorizeControlUiReadRequestOrReply } from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";

type ControlUiBootstrapRequestOptions = Partial<GatewayHttpRequestAuthOptions> & {
  config?: OpenClawConfig;
  agentId?: string;
};

export async function prepareControlUiBootstrapConfig(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ControlUiBootstrapRequestOptions | undefined,
  basePath: string,
  terminalEnabled: boolean,
  replyOnFailure = true,
  diagnostics?: ControlUiDocumentDiagnostics,
) {
  let pluginFrameGrants: readonly ControlUiPluginFrameGrantAck[] = [];
  const requestAuth = await (async () => {
    using _ = diagnostics?.scope("auth_grants");
    return await authorizeControlUiReadRequestOrReply({
      ...opts,
      req,
      res,
      cfg: opts?.cfg ?? opts?.config,
      replyOnFailure,
      requiredOperatorMethod: "sessions.list",
      onPluginFrameGrants: (grants) => {
        pluginFrameGrants = grants;
      },
    });
  })();
  if (!requestAuth) {
    return null;
  }
  requestAuth.assertCurrent();
  if (req.method === "HEAD") {
    return { config: undefined, requestAuth };
  }
  const config = opts?.config;
  const [assistant, pluginControlUiModules, devGitBranch, preferences] = await Promise.all([
    (async () => {
      using _ = diagnostics?.scope("identity_avatar");
      const resolvedIdentity = config
        ? await resolveAssistantIdentity({ cfg: config, agentId: opts?.agentId })
        : undefined;
      const identity = resolvedIdentity ?? DEFAULT_ASSISTANT_IDENTITY;
      const avatarProjection =
        config && resolvedIdentity
          ? await resolveGatewayAssistantAvatar({
              cfg: config,
              identity: resolvedIdentity,
              httpBasePath: basePath,
            })
          : { avatar: identity.avatar, resolution: null };
      return { identity, agentId: resolvedIdentity?.agentId, avatarProjection };
    })(),
    (async () => {
      using _ = diagnostics?.scope("plugin_catalog");
      return await (authorizeOperatorScopesForMethod(
        "plugins.controlUi.list",
        requestAuth.operatorScopes,
      ).allowed
        ? import("./control-ui-plugin-assets.js").then(({ listControlUiPluginCatalog }) =>
            listControlUiPluginCatalog().then(
              ({ plugins }) => plugins,
              // The post-connect plugins.controlUi.list RPC owns user-visible catalog errors.
              () => [],
            ),
          )
        : []);
    })(),
    (async () => {
      using _ = diagnostics?.scope("git_branch");
      return await resolveDevInstallGitBranch();
    })(),
    (async () => {
      using _ = diagnostics?.scope("preferences");
      return await import("./control-ui-bootstrap-preferences.js").then(
        ({ prepareControlUiBootstrapPreferences }) =>
          prepareControlUiBootstrapPreferences(config, requestAuth),
      );
    })(),
  ]);
  const { identity, agentId: assistantAgentId, avatarProjection } = assistant;
  const avatarMeta = controlUiAvatarResolutionMeta(avatarProjection.resolution);
  requestAuth.assertCurrent();
  const bootstrapConfig = {
    preferences,
    basePath,
    assistantName: identity.name,
    assistantAvatar: avatarProjection.avatar,
    assistantAvatarSource: avatarMeta.avatarSource,
    assistantAvatarStatus: avatarMeta.avatarStatus,
    assistantAvatarReason: avatarMeta.avatarReason,
    ...(assistantAgentId ? { assistantAgentId } : {}),
    serverVersion: resolveRuntimeServiceVersion(process.env),
    serverBuildId:
      config?.gateway?.controlUi?.root === undefined
        ? (resolveRuntimeServiceBuildId() ?? undefined)
        : undefined,
    devGitBranch: devGitBranch ?? undefined,
    ...resolveControlUiBootstrapPresentation(config),
    terminalEnabled,
    cliAgentsEnabled: config?.gateway?.cliAgents?.enabled !== false,
    pluginAssetsRequireAuth: opts?.auth !== undefined && opts.auth.mode !== "none",
    pluginControlUiModules,
    pluginFrameGrants: pluginFrameGrants.map(({ pluginId, path: grantPath, match }) => ({
      pluginId,
      path: grantPath,
      match,
    })),
  } satisfies ControlUiBootstrapConfig;
  return { config: bootstrapConfig, requestAuth };
}
