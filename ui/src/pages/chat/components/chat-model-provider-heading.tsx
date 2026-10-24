import { createMemo, Show, useContext } from "solid-js";
import { resolveModelRuntimeRoute } from "../../../../../src/shared/model-runtime-route.js";
import { providerDisplayLabel } from "../../../components/provider-icon-data.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { canonicalModelAuthProviderId } from "../../../lib/model-auth.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import type { ChatModelPickerOption } from "./chat-model-picker-options.ts";
import { ChatModelProviderIcon } from "./chat-model-picker-options.tsx";
import { ChatModelSearchContext } from "./chat-model-picker-search.ts";
import type { ChatModelPickerParams } from "./chat-model-picker.tsx";

export function ChatModelProviderHeading(props: {
  params: Pick<ChatModelPickerParams, "disabled" | "providerAuth" | "onProviderSettings">;
  provider: string;
  options: ChatModelPickerOption[];
  favorites?: boolean;
  toggle?: boolean;
  more?: boolean;
  view?: {
    providerOpen(provider: string): boolean;
    toggleProvider(provider: string): void;
  };
}) {
  const search = useContext(ChatModelSearchContext);
  const providerLabel = () =>
    props.favorites ? t("chat.modelControls.favorites") : providerDisplayLabel(props.provider);
  const groupLabel = () =>
    props.favorites
      ? providerLabel()
      : t("chat.modelControls.providerModels", { provider: providerLabel() });
  const auth = () => props.params.providerAuth?.get(canonicalModelAuthProviderId(props.provider));
  const authKind = () => auth()?.kind;
  const showAuth = createMemo(
    () =>
      Boolean(auth()) &&
      !(
        auth()?.kind === "missing" &&
        props.options.some(
          (option) =>
            option.disabled &&
            (option.unavailableReason === "missing-auth" ||
              option.unavailableReason === "auth-failed"),
        )
      ),
  );
  const authLabel = () =>
    showAuth() ? [auth()?.label, auth()?.detail].filter(Boolean).join(" · ") : undefined;
  const routeDetail = () => {
    const route = resolveModelRuntimeRoute(props.provider);
    return route ? t(`chat.modelControls.routes.${route}.detail`) : undefined;
  };
  return (
    <div
      class="chat-controls__provider-heading"
      data-chat-model-provider={props.provider}
      title={[routeDetail(), authLabel()].filter(Boolean).join(" · ") || undefined}
    >
      <Show
        when={props.toggle}
        fallback={
          <>
            <ChatModelProviderIcon provider={props.provider} />
            <span class="chat-controls__provider-label">{providerLabel()}</span>
          </>
        }
      >
        <button
          class="chat-controls__provider-toggle"
          type="button"
          data-chat-model-group-toggle
          data-chat-model-provider-toggle
          aria-expanded={props.view?.providerOpen(props.provider) ? "true" : "false"}
          aria-controls={[
            search?.listId(props.provider),
            ...(props.more ? [search?.listId(`${props.provider}:more`)] : []),
          ].join(" ")}
          aria-label={`${groupLabel()} (${props.options.length})`}
          aria-description={routeDetail()}
          disabled={props.params.disabled}
          onClick={(event) => {
            event.stopPropagation();
            props.view?.toggleProvider(props.provider);
          }}
        >
          <Show
            when={props.favorites}
            fallback={<ChatModelProviderIcon provider={props.provider} />}
          >
            <Icon name="star" class="chat-controls__provider-icon" />
          </Show>
          <span class="chat-controls__provider-label">{providerLabel()}</span>
          <span>{props.options.length}</span>
          <span class="chat-controls__inline-select-chevron" aria-hidden="true">
            <Icon name="chevronDown" />
          </span>
        </button>
      </Show>
      {showAuth() ? (
        <span class="chat-controls__auth-meta" data-auth-kind={authKind()}>
          <span aria-hidden="true">
            <Icon
              name={
                authKind() === "subscription"
                  ? "circleUser"
                  : authKind() === "api"
                    ? "key"
                    : "alertTriangle"
              }
            />
          </span>
          <span class="chat-controls__auth-meta-label">{authLabel()}</span>
        </span>
      ) : undefined}
      {props.params.onProviderSettings && !props.favorites ? (
        <button
          class="chat-controls__provider-settings"
          data-chat-model-provider-settings
          type="button"
          aria-label={t("chat.modelControls.configureModels")}
          onClick={(event: MouseEvent) => {
            event.stopPropagation();
            props.params.onProviderSettings?.(props.provider);
          }}
        >
          <Icon name="settings" />
        </button>
      ) : undefined}
    </div>
  );
}
