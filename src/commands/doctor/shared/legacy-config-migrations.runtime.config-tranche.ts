// Config-tranche migrations move legacy aliases before canonical validation.
import { ensureRecord, getRecord } from "../../../config/legacy.shared.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/account-id.js";
import { deleteRetiredPath, visitAgentConfigScopes } from "./legacy-config-record-shared.js";

function stripRetiredPresentationPrefs(raw: Record<string, unknown>, changes: string[]): void {
  const prefs = getRecord(getRecord(raw.ui)?.prefs);
  if (!prefs) {
    return;
  }
  const removed = [
    "chatMessageMaxWidth",
    "textScale",
    "sidebarLiveActivity",
    "showAdvancedSettings",
  ].filter((key) => deleteRetiredPath(prefs, [key]));
  if (removed.length > 0) {
    changes.push(
      `Removed browser-local ui.prefs keys: ${removed.map((key) => `ui.prefs.${key}`).join(", ")}.`,
    );
  }
  const ui = getRecord(raw.ui);
  if (Object.keys(prefs).length === 0) {
    delete ui?.prefs;
  }
  if (ui && Object.keys(ui).length === 0) {
    delete raw.ui;
  }
}

function stripRetiredAgentConfig(raw: Record<string, unknown>, changes: string[]): void {
  let removedContextLimits = false;
  let removedTypingOverride = false;
  visitAgentConfigScopes(raw, (owner, path) => {
    for (const key of ["memoryGetDefaultLines", "toolResultMaxChars"]) {
      removedContextLimits =
        deleteRetiredPath(owner, ["contextLimits", key]) || removedContextLimits;
    }
    if (path !== "agents.defaults") {
      removedTypingOverride =
        deleteRetiredPath(owner, ["typingIntervalSeconds"]) || removedTypingOverride;
    }
  });
  if (removedTypingOverride) {
    changes.push(
      "Removed per-agent typingIntervalSeconds overrides; agents.defaults.typingIntervalSeconds now applies to every agent.",
    );
  }
  if (removedContextLimits) {
    changes.push(
      "Removed contextLimits.memoryGetDefaultLines/toolResultMaxChars overrides; canonical memory and context-window caps now apply.",
    );
  }
}

type LegacyWhatsAppDebounce = { path: string; value?: number; accountId?: string };
type LegacyWhatsAppDebounceWithValue = LegacyWhatsAppDebounce & { value: number };

function migrateWhatsAppDebounce(raw: Record<string, unknown>, changes: string[]): void {
  const whatsapp = getRecord(getRecord(raw.channels)?.whatsapp);
  if (!whatsapp) {
    return;
  }
  const sources: LegacyWhatsAppDebounce[] = [];
  const accounts = getRecord(whatsapp.accounts) ?? {};
  for (const [accountId, value] of [
    [undefined, whatsapp] as const,
    ...Object.keys(accounts)
      .toSorted()
      .map((id) => [id, accounts[id]] as const),
  ]) {
    const owner = getRecord(value);
    if (!owner || !Object.hasOwn(owner, "debounceMs")) {
      continue;
    }
    const debounce = owner.debounceMs;
    delete owner.debounceMs;
    sources.push({
      path: `channels.whatsapp${accountId === undefined ? "" : `.accounts.${accountId}`}.debounceMs`,
      accountId: accountId === undefined ? undefined : normalizeAccountId(accountId),
      value:
        typeof debounce === "number" && Number.isInteger(debounce) && debounce >= 0
          ? debounce
          : undefined,
    });
  }
  if (sources.length === 0) {
    return;
  }

  const validSources = sources.filter(
    (source): source is LegacyWhatsAppDebounceWithValue => source.value !== undefined,
  );
  if (validSources.length === 0) {
    changes.push(
      `Removed invalid WhatsApp debounce values: ${sources.map((source) => source.path).join(", ")}.`,
    );
    return;
  }

  const inbound = ensureRecord(ensureRecord(raw, "messages"), "inbound");
  const byChannel = ensureRecord(inbound, "byChannel");
  if (byChannel.whatsapp !== undefined) {
    changes.push(
      `Removed ${sources.map((source) => source.path).join(", ")} (messages.inbound.byChannel.whatsapp already set).`,
    );
    return;
  }

  const configuredDefaultAccount = normalizeAccountId(
    typeof whatsapp.defaultAccount === "string" ? whatsapp.defaultAccount : undefined,
  );
  const selected =
    validSources.find((source) => source.accountId === configuredDefaultAccount) ??
    validSources.find((source) => source.accountId === DEFAULT_ACCOUNT_ID) ??
    validSources.find((source) => source.path === "channels.whatsapp.debounceMs") ??
    validSources[0];
  if (!selected) {
    return;
  }
  byChannel.whatsapp = selected.value;
  const distinctValues = new Set(validSources.map((source) => source.value));
  if (distinctValues.size === 1 && validSources.length === sources.length) {
    changes.push(
      `Moved ${sources.map((source) => source.path).join(", ")} → messages.inbound.byChannel.whatsapp.`,
    );
  } else {
    changes.push(
      `Collapsed conflicting WhatsApp debounce values into messages.inbound.byChannel.whatsapp using ${selected.path} (${selected.value} ms); account-specific debounce is no longer supported.`,
    );
  }
}

export function migrateConfigTranche(raw: Record<string, unknown>, changes: string[]): void {
  stripRetiredPresentationPrefs(raw, changes);
  if (deleteRetiredPath(raw, ["skills", "load", "watchDebounceMs"])) {
    changes.push("Removed skills.load.watchDebounceMs; the watcher now uses the 250 ms default.");
  }
  stripRetiredAgentConfig(raw, changes);
  migrateWhatsAppDebounce(raw, changes);
}

export function hasConfigTrancheLegacyKeys(root: Record<string, unknown>): boolean {
  const changes: string[] = [];
  migrateConfigTranche(structuredClone(root), changes);
  return changes.length > 0;
}
