import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SystemAgentSetupActivateResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { readAgentModelCatalog } from "../../lib/model-catalog-store.ts";
import { selectableRuntimeId } from "../../lib/model-runtime-choice.ts";
import { openPreferredApplicationSession } from "../../lib/sessions/route-navigation.ts";
import { modelProviderErrorMessage, type ModelProviderRowMessage } from "./config-mutation.ts";

/** The model a just-added key was activated with; the add dialog offers to chat with it. */
export type AddedChatModel = { provider: string; id: string; name: string; agentRuntime?: string };

/**
 * Activates a just-saved key for an agent with no usable model through the same owner and
 * connection check as Test & use, so adding the first provider ends with a model ready to chat.
 */
export async function activateAddedKey(params: {
  context: ApplicationContext;
  client: GatewayBrowserClient;
  agentId: string;
  profileId: string;
  provider: string;
}): Promise<{ message: ModelProviderRowMessage; model?: AddedChatModel }> {
  let result: SystemAgentSetupActivateResult;
  try {
    result = await params.client.request<SystemAgentSetupActivateResult>(
      "openclaw.setup.activate",
      { kind: `saved-auth:${params.profileId}`, agentId: params.agentId },
      { timeoutMs: null },
    );
  } catch (error) {
    return {
      message: {
        kind: "warning",
        text: t("modelProviders.apiKey.checkUnavailable"),
        warning: modelProviderErrorMessage(error),
      },
    };
  }
  if (!result.ok || !result.modelRef) {
    const reason = formatUiExternalText(result.error ?? t("modelProviders.requestFailed"));
    // Only a refused credential or account is about the key; anything else leaves it unproven.
    const rejected = result.status === "auth" || result.status === "billing";
    return {
      message: {
        kind: rejected ? "error" : "warning",
        text: t(
          rejected
            ? "modelProviders.apiKey.checkFailed"
            : "modelProviders.apiKey.checkInconclusive",
          { reason },
        ),
      },
    };
  }
  const slash = result.modelRef.indexOf("/");
  const provider = result.modelRef.slice(0, slash);
  const id = result.modelRef.slice(slash + 1);
  const known = readAgentModelCatalog(params.client, params.agentId).models.find(
    (model) => model.provider === provider && model.id === id,
  );
  const agentRuntime = known ? selectableRuntimeId(known.agentRuntime) : undefined;
  const model = {
    provider,
    id,
    name: known?.name ?? id,
    ...(agentRuntime ? { agentRuntime } : {}),
  };
  return {
    message: {
      kind: "success",
      text: t("modelProviders.add.ready", { provider: params.provider, model: model.name }),
    },
    model,
  };
}

/** Opens a new chat on the activated model, as sign-in's Start chat does. */
export async function startAddedChat(
  context: ApplicationContext,
  agentId: string,
  model: AddedChatModel,
): Promise<string | null> {
  const key = await context.sessions.create({
    agentId,
    model: `${model.provider}/${model.id}`,
    ...(model.agentRuntime ? { agentRuntime: model.agentRuntime } : {}),
  });
  if (key) {
    openPreferredApplicationSession(context, key, agentId);
    return null;
  }
  return context.sessions.state.error ?? t("modelProviders.requestFailed");
}
