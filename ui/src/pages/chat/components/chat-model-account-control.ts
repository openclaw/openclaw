import type {
  ChatAccountSelection,
  UserModelAccount,
  UsersListModelAccountsResult,
} from "../../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ModelAuthStatusResult } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import { registerModelAccountsEnglish } from "../../../i18n/locales/en-model-accounts.ts";
import { normalizeChatModelProviderId } from "../../../lib/chat/model-ref.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { canonicalModelAuthProviderId } from "../../../lib/model-auth.ts";
import { solidTemplate } from "./chat-composer-controls.ts";
import { ChatModelAccountSectionView } from "./chat-model-account-control.tsx";
import type { ChatModelAccountSectionViewProps } from "./chat-model-types.ts";

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
  render: (startIndex: number) => ReturnType<typeof solidTemplate>;
  viewProps: (startIndex: number) => ChatModelAccountSectionViewProps;
  onClose: () => void;
};

export function renderChatModelAccountControl(params: {
  modelAuthStatusResult?: ModelAuthStatusResult | null;
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
  const profiles =
    params.modelAuthStatusResult?.providers
      .filter(
        (p) =>
          canonicalModelAuthProviderId(normalizeChatModelProviderId(p.provider)) ===
          canonicalModelAuthProviderId(provider),
      )
      .flatMap((p) => p.profiles) ?? [];
  const email = (profileId: string | undefined) =>
    profiles.find((profile) => profile.profileId === profileId)?.email;
  const selectedProfile = profiles.find((profile) => profile.profileId === currentId);
  const selectedLabel = selectedProfile?.displayName || selection.label;
  const selectedIdentity = [
    ...new Set([selectedProfile?.email, selectedLabel].filter(Boolean)),
  ].join(" · ");
  const description = (account: UserModelAccount | undefined) =>
    email(account?.authProfileId) ??
    (account &&
    currentInventory.accounts.some(
      (candidate) =>
        candidate.authProfileId !== account.authProfileId &&
        candidate.provider === account.provider &&
        candidate.label === account.label,
    )
      ? account.authProfileId
      : undefined);
  const currentValue = "current";
  const options: Array<{ value: string; label: string; description?: string; disabled?: boolean }> =
    [
      {
        value: currentValue,
        label: selectedLabel,
        description:
          email(currentId) ??
          description(
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
        ? [
            {
              value: "more",
              label: t("profilePage.modelAccounts.loadMore"),
              disabled: currentInventory.loading,
            },
          ]
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
  const toggleAccounts = () => {
    currentInventory.open = !currentInventory.open;
    params.onRequestUpdate();
    // Reopening retries an empty inventory after a failed load; loaded pages are reused.
    if (
      currentInventory.open &&
      currentInventory.accounts.length === 0 &&
      !currentInventory.loading
    ) {
      void loadAccounts();
    }
  };
  const viewProps = (startIndex: number): ChatModelAccountSectionViewProps => ({
    selectionKind: selection.kind,
    disabled: params.disabled,
    selectedIdentity,
    options,
    currentValue,
    open: currentInventory.open,
    error: currentInventory.error,
    startIndex,
    onToggle: toggleAccounts,
    onSelect: selectAccount,
  });
  return {
    onClose: () => {
      currentInventory.open = false;
      params.onRequestUpdate();
    },
    render: (startIndex) => solidTemplate(ChatModelAccountSectionView, viewProps(startIndex)),
    viewProps,
  };
}
