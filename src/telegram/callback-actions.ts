import type { OpenClawConfig } from "../config/config.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { buildCommandsPaginationKeyboard } from "../auto-reply/reply/commands-info.js";
import { buildModelsProviderData } from "../auto-reply/reply/commands-models.js";
import { resolveStoredModelOverride } from "../auto-reply/reply/model-selection.js";
import { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
import { buildCommandsMessagePaginated } from "../auto-reply/status.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import { buildTelegramGroupPeerId, resolveTelegramForumThreadId } from "./bot/helpers.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  type ProviderInfo,
} from "./model-buttons.js";

export type TelegramCallbackButton = { text: string; callback_data: string };
export type TelegramCallbackButtons = Array<Array<TelegramCallbackButton>>;

export type TelegramCallbackAction =
  | { kind: "noop" }
  | { kind: "edit"; text: string; buttons: TelegramCallbackButtons }
  | { kind: "forward"; text: string };

export type ResolveTelegramCallbackActionParams = {
  cfg: OpenClawConfig;
  accountId?: string;
  data: string;
  chatId: number | string;
  isGroup: boolean;
  isForum: boolean;
  messageThreadId?: number;
  resolvedThreadId?: number;
};

function resolveTelegramSessionModel(
  params: ResolveTelegramCallbackActionParams,
): string | undefined {
  const resolvedThreadId =
    params.resolvedThreadId ??
    resolveTelegramForumThreadId({
      isForum: params.isForum,
      messageThreadId: params.messageThreadId,
    });
  const peerId = params.isGroup
    ? buildTelegramGroupPeerId(params.chatId, resolvedThreadId)
    : String(params.chatId);
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "telegram",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: peerId,
    },
  });
  const baseSessionKey = route.sessionKey;
  const dmThreadId = !params.isGroup ? params.messageThreadId : undefined;
  const threadKeys =
    dmThreadId != null
      ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(dmThreadId) })
      : null;
  const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: route.agentId });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  const storedOverride = resolveStoredModelOverride({
    sessionEntry: entry,
    sessionStore: store,
    sessionKey,
  });
  if (storedOverride) {
    return storedOverride.provider
      ? `${storedOverride.provider}/${storedOverride.model}`
      : storedOverride.model;
  }
  const provider = entry?.modelProvider?.trim();
  const model = entry?.model?.trim();
  if (provider && model) {
    return `${provider}/${model}`;
  }
  const modelCfg = params.cfg.agents?.defaults?.model;
  return typeof modelCfg === "string" ? modelCfg : modelCfg?.primary;
}

export async function resolveTelegramCallbackAction(
  params: ResolveTelegramCallbackActionParams,
): Promise<TelegramCallbackAction> {
  const data = params.data.trim();
  if (!data) {
    return { kind: "noop" };
  }

  const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
  if (paginationMatch) {
    const pageValue = paginationMatch[1];
    if (pageValue === "noop") {
      return { kind: "noop" };
    }

    const page = Number.parseInt(pageValue, 10);
    if (Number.isNaN(page) || page < 1) {
      return { kind: "noop" };
    }

    const agentId = paginationMatch[2]?.trim() || resolveDefaultAgentId(params.cfg) || undefined;
    const skillCommands = listSkillCommandsForAgents({
      cfg: params.cfg,
      agentIds: agentId ? [agentId] : undefined,
    });
    const result = buildCommandsMessagePaginated(params.cfg, skillCommands, {
      page,
      surface: "telegram",
    });
    const buttons =
      result.totalPages > 1
        ? buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId)
        : [];
    return {
      kind: "edit",
      text: result.text,
      buttons,
    };
  }

  const modelCallback = parseModelCallbackData(data);
  if (modelCallback) {
    const modelData = await buildModelsProviderData(params.cfg);
    const { byProvider, providers } = modelData;

    if (modelCallback.type === "providers" || modelCallback.type === "back") {
      if (providers.length === 0) {
        return { kind: "edit", text: "No providers available.", buttons: [] };
      }
      const providerInfos: ProviderInfo[] = providers.map((providerId) => ({
        id: providerId,
        count: byProvider.get(providerId)?.size ?? 0,
      }));
      return {
        kind: "edit",
        text: "Select a provider:",
        buttons: buildProviderKeyboard(providerInfos),
      };
    }

    if (modelCallback.type === "list") {
      const { provider, page } = modelCallback;
      const modelSet = byProvider.get(provider);
      if (!modelSet || modelSet.size === 0) {
        const providerInfos: ProviderInfo[] = providers.map((providerId) => ({
          id: providerId,
          count: byProvider.get(providerId)?.size ?? 0,
        }));
        return {
          kind: "edit",
          text: `Unknown provider: ${provider}\n\nSelect a provider:`,
          buttons: buildProviderKeyboard(providerInfos),
        };
      }

      const models = [...modelSet].toSorted();
      const pageSize = getModelsPageSize();
      const totalPages = calculateTotalPages(models.length, pageSize);
      const safePage = Math.max(1, Math.min(page, totalPages));
      const currentModel = resolveTelegramSessionModel(params);
      const buttons = buildModelsKeyboard({
        provider,
        models,
        currentModel,
        currentPage: safePage,
        totalPages,
        pageSize,
      });
      return {
        kind: "edit",
        text: `Models (${provider}) - ${models.length} available`,
        buttons,
      };
    }

    if (modelCallback.type === "select") {
      return { kind: "forward", text: `/model ${modelCallback.provider}/${modelCallback.model}` };
    }

    return { kind: "noop" };
  }

  return { kind: "forward", text: data };
}
