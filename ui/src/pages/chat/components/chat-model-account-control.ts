import type {
  ChatAccountSelection,
  UserModelAccount,
  UsersListModelAccountsResult,
} from "../../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ModelAuthStatusResult } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import { registerModelAccountListEnglish } from "../../../i18n/locales/en-model-account-list.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { loadModelAuthStatus } from "../../../lib/model-auth.ts";
import { projectChatFields } from "../chat-field-projection.ts";
import type { prepareChatModelAccountChoices } from "./chat-model-account-control.tsx";

registerModelAccountListEnglish();

type AccountInventoryScope = {
  owner: object;
  client: GatewayBrowserClient | null | undefined;
  ownsScope: () => boolean;
};

type AccountInventory = {
  authStatus?: ModelAuthStatusResult;
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
        authStatus: undefined,
        nextCursor: undefined,
        loading: false,
        loaded: false,
        open: false,
        error: null,
        isCurrent: () => inventories.get(scope.owner) === next && scope.ownsScope(),
      },
      ["accounts", "nextCursor", "loaded", "loading", "open", "error", "authStatus"],
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

export function prefetchChatModelAccounts(scope: AccountInventoryScope, agentId?: string) {
  if (!scope.client || !scope.ownsScope()) {
    return;
  }
  const inventory = accountInventory(scope);
  accountPrefetch(inventory, scope.client)?.();
  if (agentId) {
    void loadModelAuthStatus(scope.client, { agentId })
      .then((status) => {
        if (inventory.isCurrent() && Array.isArray(status.providers)) {
          inventory.authStatus = status;
        }
      })
      .catch(() => {});
  }
}

export type ChatModelAccountSection = NonNullable<ReturnType<typeof renderChatModelAccountControl>>;

export type ChatModelAccountControlParams = AccountInventoryScope & {
  modelAuthStatusResult?: ModelAuthStatusResult | null;
  selection: ChatAccountSelection | null | undefined;
  model: string;
  disabled: boolean;
  ownsSelection?: () => boolean;
  onSelect: (account: UserModelAccount) => Promise<boolean>;
  onSelectShared?: (model: string) => Promise<boolean>;
  onSelectNative?: (model: string) => Promise<boolean>;
  onAutomatic?: () => void;
  onManage?: () => void;
};

export function renderChatModelAccountControl(params: ChatModelAccountControlParams) {
  const { selection, client } = params;
  if (!selection) {
    return undefined;
  }
  const currentInventory = accountInventory(params, selection);
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
  const viewProps = (startIndex: number, prepare: typeof prepareChatModelAccountChoices) => {
    const { selectedIdentity, options, currentValue, select } = prepare(
      params,
      selection,
      currentInventory.accounts,
      params.modelAuthStatusResult ?? currentInventory.authStatus,
    );
    return {
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
      onSelect: (value: string, event: MouseEvent) => {
        event.stopPropagation();
        if (
          !currentInventory.isCurrent() ||
          params.ownsSelection?.() === false ||
          params.disabled
        ) {
          return;
        }
        if (value === "retry") {
          event.preventDefault();
          void loadAccounts(currentInventory, client, currentInventory.nextCursor);
        } else {
          select(value);
        }
      },
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
    };
  };
  return {
    selectionKind: selection.kind,
    prefetch: params.disabled ? undefined : accountPrefetch(currentInventory, client),
    onClose: () => {
      currentInventory.open = false;
    },
    viewProps,
  };
}
