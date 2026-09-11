import { html, nothing, type TemplateResult } from "lit";
import type {
  ChatAccountSelection,
  UserModelAccount,
  UsersListModelAccountsResult,
} from "../../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerModelAccountsEnglish } from "../../../i18n/locales/en-model-accounts.ts";
import { normalizeChatModelProviderId } from "../../../lib/chat/model-ref.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { highlightModelRow, pickerMenu } from "./chat-model-picker-search.ts";

registerModelAccountsEnglish();

type AccountInventory = {
  model: string;
  selection: ChatAccountSelection;
  accounts: UserModelAccount[];
  nextCursor?: string;
  loading: boolean;
  open: boolean;
  error: string | null;
  isCurrent: () => boolean;
};

const inventories = new WeakMap<object, AccountInventory>();

export type ChatModelAccountSection = {
  render: (startIndex: number) => TemplateResult;
  onClose: () => void;
};

export function renderChatModelAccountControl(params: {
  owner: object;
  client: GatewayBrowserClient | null | undefined;
  selection: ChatAccountSelection | null | undefined;
  model: string;
  disabled: boolean;
  ownsSelection: () => boolean;
  onSelect: (account: UserModelAccount) => Promise<boolean>;
  onAutomatic?: () => void;
  onManage?: () => void;
  onRequestUpdate: () => void;
}): ChatModelAccountSection | undefined {
  const { owner, selection, client } = params;
  if (!selection) {
    return undefined;
  }
  let inventory = inventories.get(owner);
  if (
    !inventory?.isCurrent() ||
    inventory.model !== params.model ||
    inventory.selection !== selection
  ) {
    inventory = {
      model: params.model,
      selection,
      accounts: [],
      loading: false,
      open: false,
      error: null,
      isCurrent: params.ownsSelection,
    };
    inventories.set(owner, inventory);
  }
  const currentInventory = inventory;
  const ownsInventory = () =>
    inventories.get(owner) === currentInventory && currentInventory.isCurrent();
  const loadAccounts = async (cursor?: string) => {
    if (!client || !ownsInventory() || currentInventory.loading) {
      return;
    }
    currentInventory.loading = true;
    currentInventory.error = null;
    params.onRequestUpdate();
    try {
      const result = await client.request<UsersListModelAccountsResult>(
        "users.listModelAccounts",
        cursor ? { cursor } : {},
      );
      if (ownsInventory()) {
        currentInventory.accounts = cursor
          ? [...currentInventory.accounts, ...result.accounts]
          : result.accounts;
        currentInventory.nextCursor = result.nextCursor;
      }
    } catch (error) {
      if (ownsInventory()) {
        currentInventory.error = formatUiError(
          error,
          t("profilePage.modelAccounts.inventoryFailed"),
        );
      }
    } finally {
      if (ownsInventory()) {
        currentInventory.loading = false;
        params.onRequestUpdate();
      }
    }
  };
  const provider = params.model.includes("/")
    ? normalizeChatModelProviderId(params.model.slice(0, params.model.indexOf("/")))
    : "";
  const currentId = selection.kind === "automatic" ? undefined : selection.authProfileId;
  const description = (account: UserModelAccount | undefined) =>
    account &&
    currentInventory.accounts.some(
      (candidate) =>
        candidate.authProfileId !== account.authProfileId &&
        candidate.provider === account.provider &&
        candidate.label === account.label,
    )
      ? account.authProfileId
      : undefined;
  const currentValue = "current";
  const options: Array<{ value: string; label: string; description?: string; disabled?: boolean }> =
    [
      {
        value: currentValue,
        label: selection.label,
        description: description(
          currentInventory.accounts.find((account) => account.authProfileId === currentId),
        ),
      },
      ...currentInventory.accounts
        .filter((account) => account.provider === provider && account.authProfileId !== currentId)
        .map((account) => ({
          value: `account:${account.authProfileId}`,
          label: account.label,
          description: description(account),
        })),
      ...(params.onAutomatic
        ? [{ value: "automatic", label: t("chat.modelAccounts.automatic") }]
        : []),
      ...(currentInventory.loading
        ? [{ value: "loading", label: t("common.loading"), disabled: true }]
        : []),
      ...(currentInventory.nextCursor
        ? [{ value: "more", label: t("profilePage.modelAccounts.loadMore") }]
        : []),
      ...(params.onManage ? [{ value: "manage", label: t("chat.modelAccounts.manage") }] : []),
    ];
  const selectAccount = (value: string, event: MouseEvent) => {
    event.stopPropagation();
    if (!ownsInventory() || params.disabled) {
      return;
    }
    if (value === "manage") {
      params.onManage?.();
    } else if (value === "automatic") {
      params.onAutomatic?.();
    } else if (value === "more") {
      event.preventDefault();
      void loadAccounts(currentInventory.nextCursor);
    } else {
      const account = currentInventory.accounts.find(
        (candidate) =>
          `account:${candidate.authProfileId}` === value && candidate.provider === provider,
      );
      if (account) {
        void params.onSelect(account);
      }
    }
  };
  return {
    onClose: () => {
      currentInventory.open = false;
      params.onRequestUpdate();
    },
    render: (startIndex) => html`
      <section
        class="chat-controls__provider-model-group"
        data-chat-account-selection=${selection.kind}
        aria-label=${t("chat.modelAccounts.section")}
      >
        <button
          class="chat-controls__provider-heading chat-controls__account-heading"
          type="button"
          data-chat-account-group-toggle
          aria-expanded=${currentInventory.open}
          ?disabled=${params.disabled}
          @click=${() => {
            currentInventory.open = !currentInventory.open;
            params.onRequestUpdate();
            if (currentInventory.open) {
              void loadAccounts();
            }
          }}
        >
          <span class="chat-controls__provider-icon chat-controls__target-icon" aria-hidden="true"
            >${icons.users}</span
          >
          <span class="chat-controls__provider-label">${t("chat.modelAccounts.section")}</span>
          <span class="chat-controls__account-selection">${selection.label}</span>
          <span class="chat-controls__inline-select-chevron" aria-hidden="true"
            >${currentInventory.open ? icons.chevronUp : icons.chevronDown}</span
          >
        </button>
        <div
          class="chat-controls__provider-model-list"
          data-chat-model-list="true"
          role="listbox"
          aria-label=${t("chat.modelAccounts.section")}
        >
          ${options.map(
            (option, index) => html`
              <button
                class="chat-controls__inline-select-option chat-controls__model-option"
                type="button"
                role="option"
                aria-selected=${option.value === currentValue}
                data-chat-account-option=${option.value}
                data-chat-model-option=${`account:${option.value}`}
                data-chat-model-index=${startIndex + index}
                data-chat-model-name=${option.label.toLocaleLowerCase()}
                data-chat-model-keywords=${option.description?.toLocaleLowerCase() ?? ""}
                data-chat-model-provider-label="account"
                ?hidden=${!currentInventory.open}
                ?disabled=${option.disabled || params.disabled}
                @mouseenter=${(event: MouseEvent) => {
                  // SAFETY: Bound to each account option button's mouseenter event.
                  const row = event.currentTarget as HTMLButtonElement;
                  const menu = pickerMenu(row);
                  if (menu) {
                    highlightModelRow(menu, row);
                  }
                }}
                @click=${(event: MouseEvent) => selectAccount(option.value, event)}
              >
                <span class="chat-controls__model-option-provider" aria-hidden="true"
                  >${icons.users}</span
                >
                <span class="chat-controls__model-option-copy">
                  <span class="chat-controls__model-option-name"
                    >${option.label}${option.description ? html`<br /><small>${option.description}</small>` : nothing}</span
                  >
                </span>
                <span class="chat-controls__model-option-action">
                  ${option.value === currentValue ? html`<span class="chat-controls__inline-select-check" aria-hidden="true">${icons.check}</span>` : nothing}
                </span>
              </button>
            `,
          )}
        </div>
        ${
          currentInventory.error
            ? html`<span class="chat-controls__account-error" role="alert"
                >${currentInventory.error}</span
              >`
            : nothing
        }
      </section>
    `,
  };
}
