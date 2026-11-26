import type {
  ChatAccountSelection,
  UserModelAccount,
  UsersListModelAccountsResult,
} from "../../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ModelAuthStatusResult } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import { registerModelAccountListEnglish } from "../../../i18n/locales/en-model-account-list.ts";
import { normalizeChatModelProviderId } from "../../../lib/chat/model-ref.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { canonicalModelAuthProviderId } from "../../../lib/model-auth.ts";
import { projectChatFields } from "../chat-field-projection.ts";

registerModelAccountListEnglish();

type AccountInventoryScope = {
  owner: object;
  client: GatewayBrowserClient | null | undefined;
  ownsScope: () => boolean;
};

type AccountChoice = Pick<UserModelAccount, "authProfileId" | "label"> & { select: () => void };

type AccountInventory = {
  selection?: ChatAccountSelection;
  accounts: UserModelAccount[];
  nextCursor?: string;
  loaded: boolean;
  loading: boolean;
  open: boolean;
  error: string | null;
  isCurrent: () => boolean;
};

const inventories = new WeakMap<object, AccountInventory>();

function accountInventory(scope: AccountInventoryScope, selection?: ChatAccountSelection) {
  let inventory = inventories.get(scope.owner);
  if (
    !inventory?.isCurrent() ||
    (selection && inventory.selection && inventory.selection !== selection)
  ) {
    const next: AccountInventory = projectChatFields<AccountInventory>(
      {
        accounts: [],
        nextCursor: undefined,
        loading: false,
        loaded: false,
        open: false,
        error: null,
        isCurrent: () => inventories.get(scope.owner) === next && scope.ownsScope(),
      },
      ["accounts", "nextCursor", "loaded", "loading", "open", "error"],
    );
    inventories.set(scope.owner, next);
    inventory = next;
  }
  // A picker can start loading while models.list still owns the first selection response.
  inventory.selection ??= selection;
  return inventory;
}

async function loadAccounts(
  inventory: AccountInventory,
  client: AccountInventoryScope["client"],
  cursor?: string,
) {
  if (!client || !inventory.isCurrent() || inventory.loading) {
    return;
  }
  inventory.loading = true;
  inventory.error = null;
  try {
    const result = await client.request<UsersListModelAccountsResult>(
      "users.listModelAccounts",
      cursor ? { cursor } : {},
    );
    if (inventory.isCurrent()) {
      inventory.accounts = cursor ? [...inventory.accounts, ...result.accounts] : result.accounts;
      inventory.nextCursor = result.nextCursor;
      inventory.loaded = true;
    }
  } catch (error) {
    if (inventory.isCurrent()) {
      inventory.error = formatUiError(error, t("profilePage.modelAccounts.inventoryFailed"));
    }
  } finally {
    if (inventory.isCurrent()) {
      inventory.loading = false;
    }
  }
}

function accountPrefetch(inventory: AccountInventory, client: AccountInventoryScope["client"]) {
  const canPrefetch = () => client && !inventory.loaded && !inventory.loading && !inventory.error;
  return canPrefetch()
    ? () => {
        if (canPrefetch()) {
          void loadAccounts(inventory, client);
        }
      }
    : undefined;
}

export function prefetchChatModelAccounts(scope: AccountInventoryScope) {
  if (scope.client && scope.ownsScope()) {
    accountPrefetch(accountInventory(scope), scope.client)?.();
  }
}

export type ChatModelAccountSection = NonNullable<ReturnType<typeof renderChatModelAccountControl>>;

export function renderChatModelAccountControl(
  params: AccountInventoryScope & {
    modelAuthStatusResult?: ModelAuthStatusResult | null;
    selection: ChatAccountSelection | null | undefined;
    model: string;
    disabled: boolean;
    ownsSelection?: () => boolean;
    sharedAccounts?: {
      isCurrent: () => boolean;
      onSelect: (profileId: string) => Promise<boolean>;
    };
    onSelect: (account: UserModelAccount) => Promise<boolean>;
    onAutomatic?: () => void;
    onManage?: () => void;
  },
) {
  const { selection, client, sharedAccounts } = params;
  if (!selection) {
    return undefined;
  }
  const currentInventory = accountInventory(params, selection);
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
  const accountChoices = () => {
    const choices = new Map<string, AccountChoice>();
    for (const account of currentInventory.accounts) {
      if (account.provider === provider) {
        choices.set(account.authProfileId, {
          ...account,
          select: () => void params.onSelect(account),
        });
      }
    }
    if (sharedAccounts?.isCurrent()) {
      for (const profile of profiles) {
        const usable = ["ok", "expiring", "static"].includes(profile.status);
        if (usable && !choices.has(profile.profileId)) {
          choices.set(profile.profileId, {
            authProfileId: profile.profileId,
            label: profile.displayName || profile.profileId,
            select: () => void sharedAccounts.onSelect(profile.profileId),
          });
        }
      }
    }
    return choices;
  };
  const choices = accountChoices();
  const accounts = [...choices.values()];
  const email = (profileId: string | undefined) =>
    profiles.find((profile) => profile.profileId === profileId)?.email;
  const selectedProfile = profiles.find((profile) => profile.profileId === currentId);
  const selectedLabel =
    selection.kind === "automatic"
      ? t("chat.modelAccounts.automatic")
      : selectedProfile?.displayName || selection.label;
  const selectedIdentity = [
    ...new Set([selectedLabel, selectedProfile?.email].filter(Boolean)),
  ].join(" · ");
  const description = (account: AccountChoice | undefined) =>
    email(account?.authProfileId) ??
    (account &&
    accounts.some(
      (candidate) =>
        candidate.authProfileId !== account.authProfileId && candidate.label === account.label,
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
        currentId === undefined
          ? undefined
          : (email(currentId) ?? description(choices.get(currentId))),
    },
    ...accounts
      .filter((account) => account.authProfileId !== currentId)
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
  const selectAccount = (value: string, event: MouseEvent) => {
    event.stopPropagation();
    if (!currentInventory.isCurrent() || params.ownsSelection?.() === false || params.disabled) {
      return;
    }
    if (value === "manage") {
      params.onManage?.();
    } else if (value === "automatic") {
      params.onAutomatic?.();
    } else if (value === "retry") {
      event.preventDefault();
      void loadAccounts(currentInventory, client, currentInventory.nextCursor);
    } else if (value.startsWith("account:")) {
      accountChoices().get(value.slice("account:".length))?.select();
    }
  };
  const toggleAccounts = () => {
    currentInventory.open = !currentInventory.open;
    if (currentInventory.open) {
      accountPrefetch(currentInventory, client)?.();
    }
  };
  // The picker observes this section snapshot to resynchronize its search DOM.
  const open = currentInventory.open;
  const error = currentInventory.error;
  const loading = currentInventory.loading ? (currentInventory.loaded ? "more" : "initial") : null;
  const cursor = currentInventory.nextCursor;
  const viewProps = (startIndex: number) => ({
    selectionKind: selection.kind,
    disabled: params.disabled,
    selectedIdentity,
    options,
    currentValue,
    open,
    error,
    loading,
    startIndex,
    onToggle: toggleAccounts,
    onSelect: selectAccount,
    onNextPage:
      open && cursor && !loading && !error && !params.disabled
        ? () => {
            if (
              currentInventory.open &&
              currentInventory.nextCursor === cursor &&
              !currentInventory.error &&
              params.ownsSelection?.() !== false
            ) {
              void loadAccounts(currentInventory, client, cursor);
            }
          }
        : undefined,
  });
  return {
    prefetch: params.disabled ? undefined : accountPrefetch(currentInventory, client),
    onClose: () => {
      currentInventory.open = false;
    },
    viewProps,
  };
}
