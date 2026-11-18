import type { ApplicationContext } from "../../app/context.ts";
import { readGatewayOperatorAccess } from "../../app/operator-access.ts";
import { t } from "../../i18n/index.ts";
import { registerChatComposerEnglish } from "../../i18n/locales/en-chat-composer.ts";
import { currentDisplayRuntimeConfig } from "../../lib/config/config-state-model.ts";
import type { SessionToolOverrides } from "../../lib/sessions/patch.ts";
import { countSessionToolOverrides } from "../../lib/sessions/tool-overrides.ts";
import type { ChatComposerCapabilityMenuSource } from "../chat/components/chat-composer-plus-menu.types.ts";
import {
  ComposerSkillCatalog,
  composerMcpServers,
  composerWebSearchBaseEnabled,
} from "../chat/composer-capability-catalog.ts";
import type { DraftGatewayState } from "./draft-gateway-state.ts";

registerChatComposerEnglish();

/** Synchronous tool intent survives renderer changes and is read directly at submission. */
export class NewSessionCapabilities {
  private readonly skillCatalog: ComposerSkillCatalog;
  private toolOverridesValue: SessionToolOverrides | null = null;
  constructor(
    private readonly notify: () => void,
    private readonly onMutation: () => void,
  ) {
    this.skillCatalog = new ComposerSkillCatalog(notify);
  }

  get toolOverrides(): SessionToolOverrides | null {
    return this.toolOverridesValue;
  }

  setToolOverrides(toolOverrides: SessionToolOverrides | null) {
    const next = countSessionToolOverrides(toolOverrides) > 0 ? toolOverrides : null;
    if (next === this.toolOverridesValue) {
      return;
    }
    this.onMutation();
    this.toolOverridesValue = next;
    this.notify();
  }

  reset() {
    this.toolOverridesValue = null;
  }

  canStartAsDraft(context: ApplicationContext | undefined): boolean {
    const policy = context?.gateway.snapshot.hello?.policy;
    return (
      policy?.allowedSessionVisibilities?.includes("draft") === true &&
      policy?.hasMultipleSessionSharingIdentities === true
    );
  }

  composerProps(
    context: ApplicationContext | undefined,
    gateway: DraftGatewayState,
    agentId: string,
  ): {
    toolOverrides: SessionToolOverrides | null;
    capabilityMenu?: ChatComposerCapabilityMenuSource;
  } {
    if (!context) {
      return { toolOverrides: this.toolOverridesValue, capabilityMenu: undefined };
    }
    this.skillCatalog.synchronize(gateway.client, gateway.connectionEpoch);
    return {
      toolOverrides: this.toolOverridesValue,
      capabilityMenu: {
        read: () => {
          const config = context.runtimeConfig.state;
          const runtimeConfig = currentDisplayRuntimeConfig(config);
          const gatewayAvailable = gateway.connected && Boolean(gateway.client);
          const access = readGatewayOperatorAccess(context.gateway.snapshot);
          const mutationBlockedReason = !gatewayAvailable
            ? t("chat.composer.menu.offlineBlocked")
            : !runtimeConfig
              ? (config.lastError ?? t("common.loading"))
              : !access.canAdmin
                ? t("chat.composer.menu.adminBlocked")
                : null;
          return {
            basePath: context.basePath,
            skills: this.skillCatalog.rows(agentId, this.toolOverridesValue),
            skillsRead: this.skillCatalog.read(agentId),
            ...composerMcpServers(runtimeConfig, {
              auth: context.gateway.snapshot.hello?.auth ?? null,
              loading: config.configLoading,
            }),
            toolsEffectiveResult: null,
            toolsEffectiveLoading: false,
            toolsEffectiveError: false,
            toolAccessMutationBlockedReason: mutationBlockedReason,
            webSearchBaseEnabled: composerWebSearchBaseEnabled(runtimeConfig),
            mutationBlockedReason,
            canAdmin: access.canAdmin && gatewayAvailable,
            adminBlockedReason: access.canAdmin
              ? gatewayAvailable
                ? null
                : t("chat.composer.menu.offlineBlocked")
              : t("chat.composer.menu.adminBlocked"),
            onLoadSkills: () => {
              const client = gateway.client;
              const connectionEpoch = gateway.connectionEpoch;
              this.skillCatalog.load(
                client,
                connectionEpoch,
                agentId,
                () =>
                  gateway.connected &&
                  gateway.client === client &&
                  gateway.connectionEpoch === connectionEpoch,
              );
            },
            onPatchToolOverrides: (next) => this.setToolOverrides(next),
            onNavigate: (routeId, options) => context.navigate(routeId, options),
          };
        },
      },
    };
  }
}
