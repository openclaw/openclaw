import { UI_APPEARANCE_PREFERENCE_KEYS } from "../../packages/gateway-protocol/src/schema/ui-appearance-preferences.js";
import { redactConfigObject } from "../config/redact-snapshot.js";
import { computeBaseConfigUiHints } from "../config/schema-base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getCanonicalUserPreferences } from "../state/user-preferences.js";
import type { ControlUiBootstrapConfig } from "./control-ui-bootstrap-contract.js";
import type { AuthorizedControlUiReadRequest } from "./http-auth-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";

// This projection contains only core fields; their sensitivity is process-stable.
let bootstrapUiHints: ReturnType<typeof computeBaseConfigUiHints> | undefined;

export async function prepareControlUiBootstrapPreferences(
  config: OpenClawConfig | undefined,
  viewer: Pick<AuthorizedControlUiReadRequest, "operatorScopes" | "authenticatedUserProfile">,
): Promise<ControlUiBootstrapConfig["preferences"]> {
  const profileId = viewer.authenticatedUserProfile?.profileId;
  const preferencesRead = profileId
    ? getCanonicalUserPreferences(profileId, [
        ...Object.values(UI_APPEARANCE_PREFERENCE_KEYS),
        "ui.railShortcuts",
        "ui.personalSessionGroups",
      ]).catch(() => undefined)
    : undefined;
  // Config display has the same scope ceiling and redaction as config.get.
  const display =
    config && authorizeOperatorScopesForMethod("config.get", viewer.operatorScopes).allowed
      ? redactConfigObject(
          {
            ui: { prefs: config.ui?.prefs },
            gateway: { publicOrigin: config.gateway?.publicOrigin },
            messages: { queue: config.messages?.queue },
            tts: config.tts ? { maxTextLength: config.tts.maxTextLength } : null,
            tools: {
              swarm: config.tools?.swarm,
              web: { search: { enabled: config.tools?.web?.search?.enabled } },
            },
            agents: {
              entries: Object.fromEntries(
                Object.entries(config.agents?.entries ?? {}).map(([id, agent]) => [
                  id,
                  { tools: { swarm: agent.tools?.swarm } },
                ]),
              ),
            },
            mcp: {
              servers: Object.fromEntries(
                Object.entries(config.mcp?.servers ?? {}).map(([name, server]) => [
                  name,
                  {
                    enabled: server.enabled,
                    command: server.command,
                    url: server.url,
                    transport: server.transport,
                    auth: server.auth,
                    oauth: server.oauth
                      ? {
                          authProfileId: server.oauth.authProfileId,
                          identity: server.oauth.identity,
                        }
                      : undefined,
                    toolFilter: Boolean(server.toolFilter),
                    supportsParallelToolCalls: server.supportsParallelToolCalls,
                    sslVerify: server.sslVerify,
                    clientCert: Boolean(server.clientCert),
                    clientKey: Boolean(server.clientKey),
                  },
                ]),
              ),
            },
          },
          (bootstrapUiHints ??= computeBaseConfigUiHints()),
        )
      : undefined;
  // A failed optional seed leaves the connected preference reader responsible for recovery.
  const preferences = await preferencesRead;
  return {
    ...(profileId ? { profileId } : {}),
    ...(display ? { config: display } : {}),
    ...(preferences ? { entries: preferences.entries } : {}),
  };
}
