import type {
  ChatAccountSelection,
  UserModelAccount,
  UsersListModelAccountsResult,
} from "../../../../../packages/gateway-protocol/src/index.ts";
import type { GatewayBrowserClient } from "../../../api/gateway.ts";
import type { ModelAuthStatusResult, ModelCatalogEntry } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import { registerModelAccountListEnglish } from "../../../i18n/locales/en-model-account-list.ts";
import { normalizeChatModelProviderId } from "../../../lib/chat/model-ref.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { sharedModelAccountChoices } from "../../../lib/shared-model-account-choices.ts";
import { projectChatFields } from "../chat-field-projection.ts";

registerModelAccountListEnglish();

type AccountInventoryScope = {
  owner: object;
  client: GatewayBrowserClient | null | undefined;
  ownsScope: () => boolean;
};

type AccountInventory = {
  selection?: ChatAccountSelection;
  shared?: {
    key: string;
    auth?: ModelAuthStatusResult | null;
    result?: ModelAuthStatusResult;
    error?: string;
  };
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
        shared: undefined,
        nextCursor: undefined,
        loading: false,
        loaded: false,
        open: false,
        error: null,
        isCurrent: () => inventories.get(scope.owner) === next && scope.ownsScope(),
      },
      ["accounts", "shared", "nextCursor", "loaded", "loading", "open", "error"],
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
    allowShared?: boolean;
    route?: ModelCatalogEntry;
    agentId?: string;
    sessionKey?: string;
    adminIdentity?: boolean;
    onSelectShared?: (profileId: string) => Promise<boolean>;
    model: string;
    disabled: boolean;
    ownsSelection?: () => boolean;
    onSelect: (account: UserModelAccount) => Promise<boolean>;
    onAutomatic?: () => void;
    onManage?: () => void;
  },
) {
  const { selection, client } = params;
  if (!selection) {
    return undefined;
  }
  const currentInventory = accountInventory(params, selection);
  const provider = params.model.includes("/")
    ? normalizeChatModelProviderId(params.model.slice(0, params.model.indexOf("/")))
    : "";
  const currentId = selection.kind === "automatic" ? undefined : selection.authProfileId;
  const route = params.route;
  const target =
    params.allowShared &&
    params.sessionKey &&
    !params.disabled &&
    params.onSelectShared &&
    route &&
    route.available === true &&
    route.manualSelectionAllowed !== false
      ? {
          sessionKey: params.sessionKey,
          provider: route.provider,
          model: route.id,
          runtime: route.agentRuntime?.id ?? "openclaw",
        }
      : undefined;
  const key = target && JSON.stringify(target);
  const sharedSnapshot = () =>
    key &&
    currentInventory.shared?.key === key &&
    currentInventory.shared.auth === params.modelAuthStatusResult
      ? currentInventory.shared
      : undefined;
  const snapshot = sharedSnapshot();
  const loadShared = async () => {
    if (
      !client ||
      !key ||
      !target ||
      !currentInventory.isCurrent() ||
      params.ownsSelection?.() === false
    ) {
      return;
    }
    const request = { key, auth: params.modelAuthStatusResult };
    currentInventory.shared = request;
    try {
      const result = await client.request<ModelAuthStatusResult>("models.authStatus", {
        agentId: params.agentId,
        accountTarget: target,
      });
      if (currentInventory.isCurrent() && currentInventory.shared === request) {
        currentInventory.shared = { ...request, result };
      }
    } catch (error) {
      if (currentInventory.isCurrent() && currentInventory.shared === request) {
        currentInventory.shared = {
          ...request,
          error: params.adminIdentity
            ? formatUiError(error, t("profilePage.modelAccounts.inventoryFailed"))
            : t("profilePage.modelAccounts.inventoryFailed"),
        };
      }
    }
  };
  const profiles = params.modelAuthStatusResult?.providers.find(
    (record) => normalizeChatModelProviderId(record.provider) === provider,
  )?.profiles;
  const personal = currentInventory.accounts.filter((account) => account.provider === provider);
  const shared = sharedModelAccountChoices(snapshot?.result, params.model, route);
  const adminProfile = (id: string | undefined) =>
    params.adminIdentity ? profiles?.find((profile) => profile.profileId === id) : undefined;
  const personalLabel = (label: string, id: string | undefined, index: number) => {
    if (params.adminIdentity || (!label.includes("@") && (!id || !label.includes(id)))) {
      return label;
    }
    return index < 0
      ? t("chat.modelAccounts.personalAccount")
      : t("chat.modelAccounts.personalNumber", { number: String(index + 1) });
  };
  const selectedProfile = adminProfile(currentId);
  const selectedLabel =
    selection.kind === "automatic"
      ? t("chat.modelAccounts.automatic")
      : selectedProfile?.displayName ||
        (selection.kind === "shared"
          ? (shared.find((choice) => choice.profileId === currentId)?.label ??
            (params.adminIdentity ? selection.label : t("chat.modelAccounts.sharedAccount")))
          : personalLabel(
              selection.label,
              currentId,
              personal.findIndex((a) => a.authProfileId === currentId),
            ));
  const currentValue = "current";
  const current = {
    value: currentValue,
    label: selectedLabel,
    description: selectedProfile?.email,
  };
  const options: Array<{
    value: string;
    label: string;
    group?: string;
    description?: string;
    disabled?: boolean;
  }> = [];
  if (selection.kind === "automatic" || (selection.kind === "personal" && !currentId)) {
    options.push(current);
  } else if (params.onAutomatic) {
    options.push({ value: "automatic", label: t("chat.modelAccounts.automatic") });
  }
  const sharedGroup = t("chat.modelAccounts.shared");
  if (selection.kind === "shared") {
    options.push({ ...current, group: sharedGroup });
  }
  for (const choice of shared) {
    if (
      choice.profileId !== currentId &&
      !personal.some((a) => a.authProfileId === choice.profileId)
    ) {
      const profile = params.adminIdentity ? choice : undefined;
      options.push({
        value: `shared:${choice.profileId}`,
        label:
          profile?.displayName ||
          profile?.email ||
          (params.adminIdentity ? choice.profileId : choice.label),
        group: sharedGroup,
        description: profile?.displayName ? profile.email : undefined,
      });
    }
  }
  const personalGroup = t("chat.modelAccounts.personal");
  if (selection.kind === "personal" && currentId) {
    options.push({ ...current, group: personalGroup });
  }
  for (const [index, account] of personal.entries()) {
    if (account.authProfileId !== currentId) {
      options.push({
        value: `account:${account.authProfileId}`,
        group: personalGroup,
        label: personalLabel(account.label, account.authProfileId, index),
        description: adminProfile(account.authProfileId)?.email,
      });
    }
  }
  if (params.onManage) {
    options.push({ value: "manage", label: t("chat.modelAccounts.manage") });
  }
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
      if (currentInventory.error) {
        void loadAccounts(currentInventory, client, currentInventory.nextCursor);
      }
      if (snapshot?.error) {
        void loadShared();
      }
    } else if (value.startsWith("shared:")) {
      const choice = shared.find((entry) => `shared:${entry.profileId}` === value);
      if (choice && sharedSnapshot() === snapshot) {
        void params.onSelectShared?.(choice.profileId);
      }
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
    if (currentInventory.open) {
      accountPrefetch(currentInventory, client)?.();
      if (target && !sharedSnapshot()) {
        void loadShared();
      }
    }
  };
  // The picker observes this section snapshot to resynchronize its search DOM.
  const open = currentInventory.open;
  const error = currentInventory.error ?? snapshot?.error ?? null;
  const loading = currentInventory.loading
    ? currentInventory.loaded
      ? "more"
      : "initial"
    : snapshot && !snapshot.result && !snapshot.error
      ? "more"
      : null;
  const cursor = currentInventory.nextCursor;
  const viewProps = (startIndex: number) => ({
    selectionKind: selection.kind,
    disabled:
      params.disabled ||
      (currentInventory.loaded &&
        (!target || Boolean(snapshot?.result)) &&
        !cursor &&
        !error &&
        options.length === 1),
    selectedIdentity: selectedLabel,
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
  const personalPrefetch = accountPrefetch(currentInventory, client);
  const prefetch =
    personalPrefetch || (target && !snapshot)
      ? () => {
          personalPrefetch?.();
          if (target && !sharedSnapshot()) {
            void loadShared();
          }
        }
      : undefined;
  return {
    prefetch: params.disabled ? undefined : prefetch,
    onClose: () => {
      currentInventory.open = false;
      currentInventory.shared = undefined;
    },
    viewProps,
  };
}
