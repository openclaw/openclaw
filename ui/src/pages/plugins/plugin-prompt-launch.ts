import type { ApplicationContext } from "../../app/context.ts";
import { formatUiError } from "../../lib/format-error.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import type { PluginMutationResult } from "../../lib/plugins/index.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { resolveSessionNavigationAgentId } from "../../lib/sessions/route-navigation.ts";
import { openPluginPromptChat } from "./plugin-prompt-chat.ts";
import { pluginRowKey, type PluginRowMessage } from "./plugin-row-message.tsx";
import type { createPluginsConsent } from "./plugins-consent.ts";
import {
  installRequestForDiscoveryDetail,
  type createPluginsPageState,
} from "./plugins-page-model.ts";

/** One page-owned intent survives install-policy/capability review, not route or Gateway changes. */
export function createPluginPromptLaunch(host: {
  context: ApplicationContext;
  gateway: () => GatewayPageBinding;
  state: ReturnType<typeof createPluginsPageState>;
  consent: () => Pick<
    ReturnType<typeof createPluginsConsent>,
    "read" | "install" | "mutateInstalledPlugin"
  >;
  isActive: () => boolean;
  pathname: () => string | undefined;
  accessBlockedReason: (mutationAllowed?: boolean) => string | null;
  setMessage: (key: string, message: PluginRowMessage | null) => void;
  publish: () => void;
}) {
  let pending: {
    prompt: string;
    rowKey: string;
    isCurrent: () => boolean;
    opening: boolean;
  } | null = null;
  const selected = () => {
    const catalog = host.state.detail?.catalog ?? host.state.catalogDetail?.result;
    const pluginId = host.state.detail?.pluginId ?? catalog?.plugin.local.pluginId;
    const installed = host.state.result?.plugins.find(
      (plugin) => plugin.id === pluginId && plugin.installed,
    );
    const prompts =
      installed?.recommendedPrompts ??
      host.state.detail?.inspection?.overview?.recommendedPrompts ??
      catalog?.detail.recommendedPrompts;
    return { catalog, installed, prompts };
  };
  const blockedReason = (): string | null => {
    const { installed, prompts } = selected();
    if (!prompts?.length) {
      return null;
    }
    const access = readSessionMethodAccess(host.context.gateway.snapshot, {
      method: "sessions.create",
      params: { agentId: resolveSessionNavigationAgentId(host.context) },
      sessionScope: true,
    });
    if (!access.allowed) {
      return access.reason;
    }
    return installed?.enabled || installed?.state === "needs-setup"
      ? null
      : host.accessBlockedReason(host.state.result?.mutationAllowed);
  };
  const onMessage = (key: string, message: PluginRowMessage | null) => {
    if (message?.kind === "error" && pending?.rowKey === key) {
      pending = null;
    }
  };
  const setMessage = (key: string, message: PluginRowMessage | null) => {
    onMessage(key, message);
    host.setMessage(key, message);
  };
  const complete = async (result: Pick<PluginMutationResult, "plugin">, rowKey: string) => {
    const intent = pending;
    if (
      !intent ||
      intent.rowKey !== rowKey ||
      intent.opening ||
      !intent.isCurrent() ||
      !result.plugin.installed
    ) {
      return;
    }
    intent.opening = true;
    host.publish();
    try {
      await openPluginPromptChat(host.context, result.plugin.id, intent.prompt, intent.isCurrent);
    } catch (error) {
      if (intent.isCurrent()) {
        setMessage(pluginRowKey(result.plugin.id), { kind: "error", text: formatUiError(error) });
      }
    } finally {
      if (pending === intent) {
        pending = null;
        host.publish();
      }
    }
  };
  return {
    blockedReason,
    complete,
    onMessage,
    get pending() {
      return pending !== null;
    },
    reset(this: void) {
      pending = null;
    },
    async select(prompt: string) {
      const scope = host.gateway().capture();
      if (!scope || pending || blockedReason()) {
        return;
      }
      const { installed, prompts, catalog } = selected();
      if (!prompts?.includes(prompt)) {
        return;
      }
      const rowKey = installed ? pluginRowKey(installed.id) : `install:${catalog?.plugin.id}`;
      const pathname = host.pathname();
      const agentIntent = host.context.agentSelection.intentRevision;
      const intent = {
        prompt,
        rowKey,
        isCurrent: (): boolean =>
          pending === intent &&
          host.isActive() &&
          host.gateway().isCurrent(scope) &&
          host.pathname() === pathname &&
          host.context.agentSelection.intentRevision === agentIntent,
        opening: false,
      };
      pending = intent;
      host.publish();
      const consent = host.consent();
      if (installed && (installed.enabled || installed.state === "needs-setup")) {
        await complete({ plugin: installed }, rowKey);
      } else if (installed) {
        await consent.mutateInstalledPlugin(installed.id, "enable", rowKey);
      } else {
        const request = catalog && installRequestForDiscoveryDetail(catalog);
        if (request) {
          await consent.install(request, rowKey);
        } else {
          setMessage(rowKey, { kind: "error", text: t("pluginsPage.installAvailabilityChanged") });
        }
      }
      if (
        pending === intent &&
        !consent.read().consent &&
        !host.state.messages[rowKey]?.installPolicyWarning
      ) {
        pending = null;
        host.publish();
      }
    },
  };
}
