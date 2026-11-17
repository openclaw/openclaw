import { createMemo, Show } from "solid-js";
import { IconButton } from "../../../components/solid/icon-button.tsx";
import { normalizeChatModelProviderId } from "../../../lib/chat/model-ref.ts";
import {
  canonicalModelAuthProviderId,
  listEffectiveModelAuthProviders,
} from "../../../lib/model-auth.ts";
import {
  describeModelProviderAuth,
  type ModelProviderAuthLabel,
} from "../../../lib/model-provider-auth-label.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatModelAccountSection } from "./chat-model-account-control.ts";
import { ChatModelAccountSectionView } from "./chat-model-account-control.tsx";
import { normalizeChatModelProviderGroupId } from "./chat-model-catalog-presentation.ts";
import { modelCooldownDeadline, type ChatModelPickerOption } from "./chat-model-picker-options.ts";
import { ChatModelCooldown } from "./chat-model-picker-options.tsx";
import type { ChatModelPickerParams } from "./chat-model-picker.tsx";

export function prepareChatModelProviderAuth(
  modelAuthStatusResult: ChatModelPickerParams["modelAuthStatusResult"],
  selectedId: string | undefined,
): ReadonlyMap<string, ModelProviderAuthLabel> {
  const providerAuth = new Map<string, ModelProviderAuthLabel>();
  const headingKey = (id: string) => {
    const provider = normalizeChatModelProviderId(id);
    // Usage aliases are not billing identities: Claude CLI's native account
    // and the direct Anthropic API connection own separate authentication identities.
    return provider === "claude-cli"
      ? provider
      : normalizeChatModelProviderGroupId(canonicalModelAuthProviderId(provider));
  };
  // Alias records (e.g. google and google-gemini-cli) share one heading, so merge
  // them under that key first; iterating raw records let the later one overwrite it.
  for (const provider of listEffectiveModelAuthProviders(
    modelAuthStatusResult?.providers ?? [],
    headingKey,
  )) {
    const selectedProfile =
      selectedId && provider.provider === "claude-cli"
        ? modelAuthStatusResult?.providers
            .filter((record) => canonicalModelAuthProviderId(record.provider) === "anthropic")
            .flatMap((record) => record.profiles)
            .find((profile) => profile.profileId === selectedId)
        : undefined;
    const auth = describeModelProviderAuth(
      selectedProfile ? { ...provider, profiles: [selectedProfile] } : provider,
      { authProfileId: selectedId },
    );
    if (auth) {
      providerAuth.set(headingKey(provider.provider), auth);
      // A saved account can serve either runtime, but the direct API's
      // automatic credential summary must not label native CLI login.
      if (
        provider.provider === "anthropic" &&
        provider.profiles.some((profile) => profile.profileId === selectedId)
      ) {
        providerAuth.set("claude-cli", auth);
      }
    }
  }
  return providerAuth;
}

/** The rail and Favorites use the same stack header; Favorites has only a title. */
export function ChatModelProviderHeading(props: {
  provider: string;
  label: string;
  favorites: boolean;
  options: ChatModelPickerOption[];
  cooldown: boolean;
  auth: ModelProviderAuthLabel | undefined;
  accounts: ReturnType<ChatModelAccountSection["viewProps"]> | undefined;
  onSettings: ChatModelPickerParams["onProviderSettings"];
}) {
  const showAuth = createMemo(
    () =>
      Boolean(props.auth) &&
      !props.options.some(
        (option) =>
          option.disabled &&
          (option.unavailableReason === "missing-auth" ||
            option.unavailableReason === "auth-failed"),
      ),
  );
  const authLabel = () => [props.auth?.label, props.auth?.detail].filter(Boolean).join(" · ");
  const cooldownUntil = () => (props.cooldown ? modelCooldownDeadline(props.options) : undefined);
  return (
    <div class="chat-controls__provider-heading" data-chat-model-provider={props.provider}>
      <span class="chat-controls__provider-label">{props.label}</span>
      <Show when={!props.favorites}>
        {props.accounts ? (
          <ChatModelAccountSectionView {...props.accounts} />
        ) : showAuth() ? (
          <span class="chat-controls__auth-meta" data-auth-kind={props.auth?.kind}>
            <span class="chat-controls__auth-meta-label">
              {props.auth?.kind === "api" ? t("modelProviders.status.apiKey") : authLabel()}
            </span>
          </span>
        ) : undefined}
        <Show when={cooldownUntil()}>{(until) => <ChatModelCooldown until={until()} />}</Show>
        <Show when={props.onSettings}>
          <IconButton
            icon="settings"
            size={28}
            tooltip={false}
            class="chat-controls__provider-settings"
            data-chat-model-provider-settings
            type="button"
            label={t("chat.modelControls.configureModels")}
            onClick={(event) => {
              event.stopPropagation();
              props.onSettings?.(props.provider);
            }}
          />
        </Show>
      </Show>
    </div>
  );
}
