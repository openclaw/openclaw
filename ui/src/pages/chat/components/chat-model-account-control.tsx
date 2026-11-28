import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, createUniqueId, For, Show, useContext } from "solid-js";
import type {
  ChatAccountSelection,
  UserModelAccount,
} from "../../../../../packages/gateway-protocol/src/index.ts";
import { CLAUDE_CLI_PROFILE_ID } from "../../../../../src/agents/auth-profiles/profile-ids.ts";
import { isUserModelAuthProfileId } from "../../../../../src/state/user-model-account-id.ts";
import { Icon } from "../../../components/solid/icon.tsx";
import { Popover } from "../../../components/solid/popover.tsx";
import { normalizeChatModelProviderId } from "../../../lib/chat/model-ref.ts";
import { canonicalModelAuthProviderId } from "../../../lib/model-auth.ts";
import { t } from "../../../lib/reactive/i18n.ts";
import { createIntersectionObserver } from "../../../lib/reactive/observers.ts";
import type {
  ChatModelAccountControlParams,
  ChatModelAccountSection,
} from "./chat-model-account-control.ts";
import { ChatModelSearchContext } from "./chat-model-picker-search.ts";
import type { ModelPickerRowRenderer } from "./chat-model-picker-window.tsx";

export function prepareChatModelAccountChoices(
  params: ChatModelAccountControlParams,
  selection: ChatAccountSelection,
  accounts: UserModelAccount[],
  authStatus: ChatModelAccountControlParams["modelAuthStatusResult"] = params.modelAuthStatusResult,
) {
  const provider = params.model.includes("/")
    ? normalizeChatModelProviderId(params.model.slice(0, params.model.indexOf("/")))
    : "";
  const currentId = selection.kind === "automatic" ? undefined : selection.authProfileId;
  const profiles =
    authStatus?.providers
      .filter(
        (p) =>
          canonicalModelAuthProviderId(normalizeChatModelProviderId(p.provider)) ===
          canonicalModelAuthProviderId(provider),
      )
      .flatMap((p) => p.profiles) ?? [];
  const native =
    (provider === "anthropic" || provider === "claude-cli") && params.onSelectNative
      ? authStatus?.providers.find(
          (p) => p.provider === "claude-cli" && p.nativeAuth && p.status === "ok",
        )?.nativeAuth
      : undefined;
  const nativeLabel = t("chat.modelControls.routes.claudeCli.label");
  const shared = params.onSelectShared
    ? profiles.filter(
        (p) =>
          !isUserModelAuthProfileId(p.profileId) &&
          p.profileId !== CLAUDE_CLI_PROFILE_ID &&
          p.profileId !== currentId &&
          !accounts.some((a) => a.authProfileId === p.profileId),
      )
    : [];
  const email = (profileId: string | undefined) =>
    profiles.find((profile) => profile.profileId === profileId)?.email;
  const selectedProfile = profiles.find((profile) => profile.profileId === currentId);
  const selectedLabel =
    selection.kind === "automatic"
      ? t("chat.modelAccounts.automatic")
      : native && currentId === CLAUDE_CLI_PROFILE_ID
        ? nativeLabel
        : selectedProfile?.displayName || selection.label;
  const selectedIdentity = [
    ...new Set([selectedLabel, selectedProfile?.email].filter(Boolean)),
  ].join(" · ");
  const description = (account: UserModelAccount | undefined) =>
    email(account?.authProfileId) ??
    (account &&
    accounts.some(
      (candidate) =>
        candidate.authProfileId !== account.authProfileId &&
        candidate.provider === account.provider &&
        candidate.label === account.label,
    )
      ? account.authProfileId
      : undefined);
  const currentValue = "current";
  const options: ReadonlyArray<{
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
  }> = [
    {
      value: currentValue,
      label: selectedLabel,
      description:
        (currentId === CLAUDE_CLI_PROFILE_ID ? native?.plan : undefined) ??
        email(currentId) ??
        description(accounts.find((account) => account.authProfileId === currentId)),
    },
    ...(native && currentId !== CLAUDE_CLI_PROFILE_ID
      ? [{ value: "native", label: nativeLabel, description: native.plan }]
      : []),
    ...shared.map((p) => ({
      value: `shared:${p.profileId}`,
      label: p.displayName || p.profileId,
      description: p.email,
    })),
    ...accounts
      .filter((account) => account.provider === provider && account.authProfileId !== currentId)
      .map((account) => ({
        value: `account:${account.authProfileId}`,
        label: account.label,
        description: description(account),
      })),
    ...(params.onAutomatic
      ? [{ value: "automatic", label: t("chat.modelAccounts.automatic") }]
      : []),
    ...(params.onManage ? [{ value: "manage", label: t("chat.modelAccounts.manage") }] : []),
  ];
  const select = (value: string) => {
    if (value === "manage") {
      params.onManage?.();
    } else if (native && value === "native") {
      const modelId = params.model.slice(params.model.indexOf("/") + 1);
      void params.onSelectNative?.(`anthropic/${modelId}`);
    } else if (value.startsWith("shared:")) {
      const profile = shared.find((p) => p.profileId === value.slice("shared:".length));
      if (profile) {
        void params.onSelectShared?.(`${params.model}@${profile.profileId}`);
      }
    } else if (value === "automatic") {
      params.onAutomatic?.();
    } else {
      const account = accounts.find(
        (candidate) =>
          `account:${candidate.authProfileId}` === value && candidate.provider === provider,
      );
      if (account) {
        void params.onSelect(account);
      }
    }
  };
  return { selectedIdentity, options, currentValue, select };
}

export function accountOptionSearchRows(
  account: ReturnType<ChatModelAccountSection["viewProps"]> | undefined,
) {
  return (
    account?.options.map((entry) => ({
      key: `account:${entry.value}`,
      list: "accounts",
      name: entry.label.toLocaleLowerCase(),
      keywords: entry.description?.toLocaleLowerCase(),
      providerLabel: "account",
      reference: `account:${entry.value}`,
      selected: entry.value === account.currentValue,
      hasShortcut: false,
      disabled: account.disabled || Boolean(entry.disabled),
      visible: account.open,
    })) ?? []
  );
}

function AccountPageSentinel(props: { onVisible: () => void }) {
  const [sentinel, setSentinel] = createSignal<HTMLSpanElement>();
  createIntersectionObserver(
    () => {
      const target = sentinel();
      return target ? [target] : [];
    },
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        props.onVisible();
      }
    },
  );
  // Intersect just inside the last row so keyboard focus can reveal the sentinel too.
  return (
    <span
      ref={setSentinel}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: "-12px 0 auto",
        height: "1px",
        "pointer-events": "none",
      }}
    />
  );
}

export function ChatModelAccountSectionView(
  props: ReturnType<ChatModelAccountSection["viewProps"]>,
) {
  const id = createUniqueId();
  const pending = () => !props.disabled && !props.open && props.loading === "initial";
  return (
    <span class="chat-controls__account-section" data-chat-account-selection={props.selectionKind}>
      <Popover
        id={id}
        label={t("chat.modelAccounts.section")}
        triggerClass={[
          "chat-controls__account-trigger",
          { "chat-controls__account-trigger--locked": props.disabled },
        ]}
        class="chat-controls__settings-popover chat-controls__account-popover"
        placement="bottom-start"
        sameRoot
        disabled={props.disabled || pending()}
        open={props.open}
        onOpenChange={(open) => {
          if (open !== props.open) {
            props.onToggle();
          }
        }}
        trigger={
          <>
            <span class="chat-controls__account-selection">
              {props.selectionKind === "automatic"
                ? t("chat.modelAccounts.automaticTrigger")
                : (props.options.find((option) => option.value === props.currentValue)?.label ??
                  props.selectedIdentity)}
            </span>
            <Show when={!props.disabled}>
              <Show when={pending()} fallback={<Icon name="chevronDown" />}>
                <span
                  class="btn__spinner chat-controls__account-spinner"
                  aria-hidden="true"
                  style={{ color: "var(--muted)" }}
                />
              </Show>
            </Show>
          </>
        }
      >
        <ChatModelAccountOptions {...props} />
      </Popover>
      <span class="sr-only" role="status">
        {pending() ? t("common.loading") : ""}
      </span>
    </span>
  );
}

export function ChatModelAccountOptions(
  props: ReturnType<ChatModelAccountSection["viewProps"]> & { renderRow?: ModelPickerRowRenderer },
) {
  const search = useContext(ChatModelSearchContext);
  const renderRow = createMemo(() => props.renderRow);
  const row = (key: string, render: () => JSX.Element) => {
    const renderer = renderRow();
    return renderer ? renderer(key, render) : render();
  };
  const pagination = () => (
    <Show when={!renderRow() && props.open && (props.onNextPage || props.loading)}>
      <div role="presentation" style={{ position: "relative", height: "34px" }}>
        <Show when={props.onNextPage}>{(next) => <AccountPageSentinel onVisible={next()} />}</Show>
        <Show when={props.loading}>
          <div
            class="chat-controls__account-page-loader"
            role="status"
            style={{ display: "grid", height: "100%", "place-items": "center" }}
          >
            <Show
              when={props.loading === "more"}
              fallback={
                <span
                  class="btn__spinner chat-controls__account-spinner"
                  aria-hidden="true"
                  style={{ color: "var(--muted)" }}
                />
              }
            >
              <span
                class="chat-controls__account-page-skeleton"
                aria-hidden="true"
                style={{
                  "justify-self": "start",
                  width: "42%",
                  height: "12px",
                  "margin-inline-start": "8px",
                  "border-radius": "4px",
                  background: "var(--skeleton-base-raised)",
                }}
              />
            </Show>
            <span class="sr-only">{t("common.loading")}</span>
          </div>
        </Show>
      </div>
    </Show>
  );
  return (
    <>
      <div
        id={search?.listId("accounts")}
        class="chat-controls__provider-model-list"
        data-chat-model-list="true"
        role="listbox"
        aria-label={t("chat.modelAccounts.section")}
        aria-busy={props.loading ? "true" : "false"}
      >
        <For each={props.options} keyed={(option) => option.value}>
          {(option, index) => {
            const key = createMemo(() => `account:${option().value}`);
            return (
              <>
                <Show when={option().value === "manage"}>{pagination()}</Show>
                {row(key(), () => (
                  <div
                    class={
                      option().value === "manage" ? "chat-controls__account-footer" : undefined
                    }
                  >
                    <button
                      ref={search?.rowRef(() => `account:${option().value}`)}
                      id={search?.optionId(`account:${option().value}`)}
                      class={[
                        "chat-controls__inline-select-option chat-controls__model-option",
                        {
                          "chat-controls__account-row": option().value !== "manage",
                          "chat-controls__account-manage": option().value === "manage",
                        },
                        {
                          "chat-controls__inline-select-option--selected":
                            option().value === props.currentValue,
                        },
                      ]}
                      data-has-description={option().description ? "" : undefined}
                      type="button"
                      role="option"
                      aria-selected={option().value === props.currentValue ? "true" : "false"}
                      aria-posinset={search?.row(`account:${option().value}`)?.position}
                      aria-setsize={search?.row(`account:${option().value}`)?.size}
                      data-chat-account-option={option().value}
                      data-chat-model-option={`account:${option().value}`}
                      data-chat-model-key={`account:${option().value}`}
                      data-chat-model-rank={search?.row(`account:${option().value}`)?.rank}
                      data-chat-model-highlighted={
                        search?.isHighlighted(`account:${option().value}`) ? "" : undefined
                      }
                      style={{
                        "--chat-model-rank": search?.row(`account:${option().value}`)?.rank,
                      }}
                      data-chat-model-index={props.startIndex + index()}
                      data-chat-model-name={option().label.toLocaleLowerCase()}
                      data-chat-model-keywords={option().description?.toLocaleLowerCase() ?? ""}
                      data-chat-model-provider-label="account"
                      hidden={search?.row(`account:${option().value}`)?.hidden ?? !props.open}
                      aria-disabled={option().disabled ? "true" : undefined}
                      disabled={props.disabled || option().disabled}
                      onClick={(event) => props.onSelect(option().value, event)}
                    >
                      <Show when={option().value === "manage"}>
                        <span class="chat-controls__account-gear" aria-hidden="true">
                          <Icon name="settings" />
                        </span>
                      </Show>
                      <span class="chat-controls__model-option-copy">
                        <span class="chat-controls__model-option-name">{option().label}</span>
                        <Show when={option().description}>
                          <span class="chat-controls__auth-meta">
                            <span class="chat-controls__model-option-name">
                              {option().description}
                            </span>
                          </span>
                        </Show>
                      </span>
                      <span class="chat-controls__model-option-action">
                        <Show when={option().value === props.currentValue}>
                          <span class="chat-controls__inline-select-check" aria-hidden="true">
                            <Icon name="check" />
                          </span>
                        </Show>
                      </span>
                    </button>
                  </div>
                ))}
              </>
            );
          }}
        </For>
        <Show when={!props.options.some((option) => option.value === "manage")}>
          {pagination()}
        </Show>
      </div>
      <Show when={props.error}>
        {row("error:accounts", () => (
          <div class="chat-controls__account-error">
            <span role="alert">{props.error}</span>{" "}
            <Show when={!props.loading && !props.disabled}>
              <button
                type="button"
                class="btn btn--sm"
                onClick={(event) => props.onSelect("retry", event)}
              >
                {t("common.retry")}
              </button>
            </Show>
          </div>
        ))}
      </Show>
    </>
  );
}
