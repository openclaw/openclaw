import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString as normalizeTrimmedString } from "@openclaw/normalization-core/string-coerce";
import type {
  DoctorMemoryDreamActionPayload,
  DoctorMemoryDreamDiaryPayload,
  DoctorMemoryStatusPayload,
} from "../../../../../src/gateway/server-methods/doctor.ts";
import { defaultSlotIdForKey, resolveSlotSelection } from "../../../../../src/plugins/slots.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../../api/gateway.ts";
import type { ConfigSnapshot } from "../../../api/types.ts";
import { t } from "../../../i18n/index.ts";
import { registerDreamingEnglish } from "../../../i18n/locales/en-dreaming.ts";
import { copyToClipboard } from "../../../lib/clipboard.ts";
import type { RuntimeConfigCapability } from "../../../lib/config/runtime-config-capability.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import {
  canCallGatewayMethod,
  isGatewayMethodAdvertised,
  type GatewayMethodOperatorScope,
} from "../../../lib/gateway-methods.ts";
import { isPluginEnabledInConfigSnapshot } from "../../../lib/plugin-activation.ts";

registerDreamingEnglish();

const MEMORY_WIKI_PLUGIN_ID = "memory-wiki";

type DreamingStatus = NonNullable<DoctorMemoryStatusPayload["dreaming"]>;
export type DreamingEntry = DreamingStatus["shortTermEntries"][number];

type WikiImportInsightItem = {
  pagePath: string;
  title: string;
  riskLevel: "low" | "medium" | "high" | "unknown";
  riskReasons: string[];
  labels: string[];
  topicKey: string;
  topicLabel: string;
  digestStatus: "available" | "withheld";
  activeBranchMessages: number;
  userMessageCount: number;
  assistantMessageCount: number;
  firstUserLine?: string;
  lastUserLine?: string;
  assistantOpener?: string;
  summary: string;
  candidateSignals: string[];
  correctionSignals: string[];
  preferenceSignals: string[];
  createdAt?: string;
  updatedAt?: string;
};

type WikiImportInsightCluster = {
  key: string;
  label: string;
  itemCount: number;
  highRiskCount: number;
  withheldCount: number;
  preferenceSignalCount: number;
  updatedAt?: string;
  items: WikiImportInsightItem[];
};

export type WikiImportInsights = {
  sourceType: "chatgpt";
  totalItems: number;
  totalClusters: number;
  clusters: WikiImportInsightCluster[];
  truncated: boolean;
};

type WikiOverviewItem = {
  pagePath: string;
  title: string;
  kind: "entity" | "concept" | "source" | "synthesis" | "report";
  id?: string;
  updatedAt?: string;
  sourceType?: string;
  claimCount: number;
  questionCount: number;
  contradictionCount: number;
  claims: string[];
  questions: string[];
  contradictions: string[];
  snippet?: string;
};

type WikiOverviewCluster = {
  key: WikiOverviewItem["kind"];
  label: string;
  itemCount: number;
  claimCount: number;
  questionCount: number;
  contradictionCount: number;
  updatedAt?: string;
  items: WikiOverviewItem[];
};

type WikiOverviewPageCounts = Record<WikiOverviewItem["kind"], number>;

export type WikiOverview = {
  totalItems: number;
  totalPages: number;
  pageCounts: WikiOverviewPageCounts;
  totalClaims: number;
  totalQuestions: number;
  totalContradictions: number;
  clusters: WikiOverviewCluster[];
  truncated: boolean;
};

export type WikiPagePreview = {
  title: string;
  path: string;
  content: string;
  totalLines?: number;
  truncated?: boolean;
  updatedAt?: string;
};

export type DreamingResourceKey =
  | "dreamingStatus"
  | "dreamDiary"
  | "wikiImportInsights"
  | "wikiOverview";
type DreamingResourceRequest = { agentId: string };

export type DreamingState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  configSnapshot: ConfigSnapshot | null;
  selectedAgentId: string | null;
  resourceRequests: Partial<Record<DreamingResourceKey, DreamingResourceRequest>>;
  dreamingStatusAgentId?: string | null;
  dreamingStatusLoading: boolean;
  dreamingStatusError: string | null;
  dreamingStatus: DreamingStatus | null;
  dreamingModeSaving: boolean;
  dreamDiaryAgentId?: string | null;
  dreamDiaryLoading: boolean;
  dreamDiaryActionLoading: boolean;
  dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null;
  dreamDiaryActionArchivePath: string | null;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
  wikiImportInsightsAgentId?: string | null;
  wikiImportInsightsLoading: boolean;
  wikiImportInsightsError: string | null;
  wikiImportInsights: WikiImportInsights | null;
  wikiOverviewAgentId?: string | null;
  wikiOverviewLoading: boolean;
  wikiOverviewError: string | null;
  wikiOverview: WikiOverview | null;
  lastError: string | null;
};

export function createDreamingState(
  initial: Partial<
    Pick<DreamingState, "client" | "connected" | "hello" | "configSnapshot" | "selectedAgentId">
  > = {},
): DreamingState {
  return {
    client: initial.client ?? null,
    connected: initial.connected ?? false,
    hello: initial.hello ?? null,
    configSnapshot: initial.configSnapshot ?? null,
    selectedAgentId: initial.selectedAgentId ?? null,
    resourceRequests: {},
    dreamingStatusLoading: false,
    dreamingStatusError: null,
    dreamingStatus: null,
    dreamingModeSaving: false,
    dreamDiaryLoading: false,
    dreamDiaryActionLoading: false,
    dreamDiaryActionMessage: null,
    dreamDiaryActionArchivePath: null,
    dreamDiaryError: null,
    dreamDiaryPath: null,
    dreamDiaryContent: null,
    wikiImportInsightsLoading: false,
    wikiImportInsightsError: null,
    wikiImportInsights: null,
    wikiOverviewLoading: false,
    wikiOverviewError: null,
    wikiOverview: null,
    lastError: null,
  };
}

type DreamingConfigCapability = Pick<
  RuntimeConfigCapability,
  "lookupSchemaPath" | "patch" | "state"
>;

function canCallMemoryWikiMethod(state: DreamingState, method: string): boolean {
  return (
    isGatewayMethodAdvertised(state, method) ??
    isPluginEnabledInConfigSnapshot(state.configSnapshot, MEMORY_WIKI_PLUGIN_ID, {
      enabledByDefault: false,
    })
  );
}

export function canCallDreamingMethod(
  state: DreamingState,
  method: string,
  requiredScope: GatewayMethodOperatorScope,
  options?: { requireAdvertisement?: boolean },
): boolean {
  return canCallGatewayMethod(
    {
      client: state.client,
      hello: state.hello,
      phase: state.connected ? "connected" : "offline",
    },
    method,
    requiredScope,
    options,
  );
}

export type DreamDiaryActionMethod =
  | "doctor.memory.backfillDreamDiary"
  | "doctor.memory.resetDreamDiary"
  | "doctor.memory.resetGroundedShortTerm"
  | "doctor.memory.repairDreamingArtifacts"
  | "doctor.memory.dedupeDreamDiary";

function buildDreamDiaryActionSuccessMessage(
  method: DreamDiaryActionMethod,
  payload: DoctorMemoryDreamActionPayload | undefined,
): string {
  switch (method) {
    case "doctor.memory.dedupeDreamDiary": {
      const removed = payload?.dedupedEntries ?? payload?.removedEntries ?? 0;
      const kept = payload?.keptEntries;
      if (kept !== undefined) {
        return t(
          removed === 1
            ? "dreaming.actions.dedupeRemovedOneAndKept"
            : "dreaming.actions.dedupeRemovedManyAndKept",
          { removed: String(removed), kept: String(kept) },
        );
      }
      return t(
        removed === 1 ? "dreaming.actions.dedupeRemovedOne" : "dreaming.actions.dedupeRemovedMany",
        { removed: String(removed) },
      );
    }
    case "doctor.memory.repairDreamingArtifacts": {
      const actions: string[] = [];
      const archiveDir = normalizeTrimmedString(payload?.archiveDir);
      if (payload?.archivedSessionCorpus === true) {
        actions.push(t("dreaming.actions.repairArchivedThreadCorpus"));
      }
      if (payload?.archivedSessionIngestion === true) {
        actions.push(t("dreaming.actions.repairArchivedIngestionState"));
      }
      if (payload?.archivedDreamsDiary === true) {
        actions.push(t("dreaming.actions.repairArchivedDreamDiary"));
      }
      if (actions.length === 0) {
        return t("dreaming.actions.repairNoChanges");
      }
      return archiveDir
        ? t("dreaming.actions.repairCompleteWithArchive", {
            actions: actions.join(", "),
            archiveDir,
          })
        : t("dreaming.actions.repairComplete", { actions: actions.join(", ") });
    }
    case "doctor.memory.backfillDreamDiary":
      return t("dreaming.actions.backfillComplete", {
        count: String(payload?.written ?? 0),
      });
    case "doctor.memory.resetDreamDiary":
      return t("dreaming.actions.resetDiaryComplete", {
        count: String(payload?.removedEntries ?? 0),
      });
    default:
      return t("dreaming.actions.clearReplayedComplete", {
        count: String(payload?.removedShortTermEntries ?? 0),
      });
  }
}

function resolveSelectedAgentId(state: DreamingState): string | null {
  return normalizeTrimmedString(state.selectedAgentId) ?? null;
}

export function resolveConfiguredDreaming(configValue: Record<string, unknown> | null): {
  pluginId: string;
  enabled: boolean;
  overridden: boolean;
  engineOff: boolean;
} {
  const plugins = asRecord(configValue?.plugins);
  const slots = asRecord(plugins?.slots);
  const slotSelection = resolveSlotSelection("memory", slots?.memory);
  const pluginId =
    slotSelection.kind === "off" ? defaultSlotIdForKey("memory") : slotSelection.pluginId;
  const entries = asRecord(plugins?.entries);
  const pluginEntry = asRecord(entries?.[pluginId]);
  const config = asRecord(pluginEntry?.config);
  const dreaming = asRecord(config?.dreaming);
  const overridden = typeof dreaming?.enabled === "boolean";
  return {
    pluginId,
    enabled: slotSelection.kind !== "off" && dreaming?.enabled !== false,
    overridden,
    engineOff: slotSelection.kind === "off",
  };
}

type DreamingResourcePayloads = {
  dreamingStatus: DoctorMemoryStatusPayload;
  dreamDiary: DoctorMemoryDreamDiaryPayload;
  wikiImportInsights: WikiImportInsights;
  wikiOverview: WikiOverview;
};

type DreamingResourceSpec<Key extends DreamingResourceKey> = {
  method: string;
  clear: (state: DreamingState) => void;
  apply: (state: DreamingState, payload: DreamingResourcePayloads[Key]) => void;
};

const DREAMING_RESOURCES: {
  [Key in DreamingResourceKey]: DreamingResourceSpec<Key>;
} = {
  dreamingStatus: {
    method: "doctor.memory.status",
    clear: (state) => {
      state.dreamingStatus = null;
    },
    apply: (state, payload) => {
      state.dreamingStatus = payload.dreaming ?? null;
    },
  },
  dreamDiary: {
    method: "doctor.memory.dreamDiary",
    clear: (state) => {
      state.dreamDiaryPath = null;
      state.dreamDiaryContent = null;
    },
    apply: (state, payload) => {
      state.dreamDiaryPath = payload.path;
      state.dreamDiaryContent = payload.found ? (payload.content ?? "") : null;
    },
  },
  wikiImportInsights: {
    method: "wiki.importInsights",
    clear: (state) => {
      state.wikiImportInsights = null;
    },
    apply: (state, payload) => {
      state.wikiImportInsights = payload;
    },
  },
  wikiOverview: {
    method: "wiki.overview",
    clear: (state) => {
      state.wikiOverview = null;
    },
    apply: (state, payload) => {
      state.wikiOverview = payload;
    },
  },
};

export function loadDreamingResource(
  state: DreamingState,
  key: DreamingResourceKey,
): Promise<void> {
  return loadDreamingResourceSpec(state, key, DREAMING_RESOURCES[key]);
}

async function loadDreamingResourceSpec<Key extends DreamingResourceKey>(
  state: DreamingState,
  key: Key,
  spec: (typeof DREAMING_RESOURCES)[Key],
): Promise<void> {
  const agentId = resolveSelectedAgentId(state);
  const loadingKey: `${Key}Loading` = `${key}Loading`;
  const errorKey: `${Key}Error` = `${key}Error`;
  const agentKey: `${Key}AgentId` = `${key}AgentId`;
  if (!agentId) {
    return;
  }
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  if (state[agentKey] !== agentId) {
    spec.clear(state);
  }
  if (
    (key === "wikiImportInsights" || key === "wikiOverview") &&
    !canCallMemoryWikiMethod(state, spec.method)
  ) {
    delete state.resourceRequests[key];
    state[loadingKey] = false;
    state[errorKey] = null;
    spec.clear(state);
    return;
  }

  const active = state.resourceRequests[key];
  if (active?.agentId === agentId && state[loadingKey]) {
    return;
  }

  // Request identity, not agent identity, rejects stale A -> B -> A completions.
  const request: DreamingResourceRequest = { agentId };
  state.resourceRequests[key] = request;
  state[loadingKey] = true;
  state[errorKey] = null;
  try {
    const payload = await client.request<DreamingResourcePayloads[Key]>(spec.method, { agentId });
    if (state.resourceRequests[key] !== request || resolveSelectedAgentId(state) !== agentId) {
      return;
    }
    spec.apply(state, payload);
    state[agentKey] = agentId;
  } catch (error) {
    if (state.resourceRequests[key] === request && resolveSelectedAgentId(state) === agentId) {
      state[errorKey] = formatUiError(error);
    }
  } finally {
    if (state.resourceRequests[key] === request) {
      delete state.resourceRequests[key];
      state[loadingKey] = false;
    }
  }
}

export async function runDreamDiaryAction(
  state: DreamingState,
  method: DreamDiaryActionMethod,
): Promise<boolean> {
  const client = state.client;
  const agentId = resolveSelectedAgentId(state);
  if (
    !client ||
    !agentId ||
    !canCallDreamingMethod(state, method, "operator.write") ||
    state.dreamDiaryActionLoading
  ) {
    return false;
  }
  state.dreamDiaryActionLoading = true;
  state.dreamingStatusError = null;
  state.dreamDiaryError = null;
  state.dreamDiaryActionMessage = null;
  state.dreamDiaryActionArchivePath = null;
  try {
    const payload = await client.request<DoctorMemoryDreamActionPayload>(method, { agentId });
    if (
      method !== "doctor.memory.resetGroundedShortTerm" &&
      method !== "doctor.memory.repairDreamingArtifacts"
    ) {
      await loadDreamingResource(state, "dreamDiary");
    }
    await loadDreamingResource(state, "dreamingStatus");
    state.dreamDiaryActionArchivePath =
      method === "doctor.memory.repairDreamingArtifacts"
        ? (normalizeTrimmedString(payload?.archiveDir) ?? null)
        : null;
    state.dreamDiaryActionMessage = {
      kind: "success",
      text: buildDreamDiaryActionSuccessMessage(method, payload),
    };
    return true;
  } catch (err) {
    const message = formatUiError(err);
    state.dreamingStatusError = message;
    state.lastError = message;
    state.dreamDiaryActionArchivePath = null;
    state.dreamDiaryActionMessage = { kind: "error", text: message };
    return false;
  } finally {
    state.dreamDiaryActionLoading = false;
  }
}

export async function copyDreamingArchivePath(state: DreamingState): Promise<boolean> {
  const path = state.dreamDiaryActionArchivePath;
  if (!path) {
    return false;
  }
  const copied = await copyToClipboard(path);
  state.dreamDiaryActionMessage = {
    kind: copied ? "success" : "error",
    text: t(
      copied ? "dreaming.actions.archivePathCopied" : "dreaming.actions.archivePathCopyFailed",
    ),
  };
  return copied;
}

export type DreamingConfigPathSupport = "supported" | "unsupported" | "unknown";

/**
 * Whether the slot-owning memory plugin's config schema can hold `dreaming`.
 * Only a closed schema without the child proves it cannot. An unreachable
 * gateway or a failed lookup answers "unknown", which callers treat as
 * optimistic but must not cache: the gateway still has the final say, and a
 * cached guess would survive the reconnect that could settle it.
 * Shared by the enablement toggle and the Memory page's Dreaming tab.
 */
export async function resolveDreamingConfigPathSupport(
  config: Pick<DreamingConfigCapability, "lookupSchemaPath" | "state">,
  pluginId: string,
): Promise<DreamingConfigPathSupport> {
  if (!config.state.client || !config.state.connected) {
    return "unknown";
  }
  try {
    const lookup = asRecord(await config.lookupSchemaPath(`plugins.entries.${pluginId}.config`));
    const children = Array.isArray(lookup?.children) ? lookup.children : [];
    if (children.some((child) => normalizeTrimmedString(asRecord(child)?.key) === "dreaming")) {
      return "supported";
    }
    return asRecord(lookup?.schema)?.additionalProperties === false ? "unsupported" : "supported";
  } catch {
    return "unknown";
  }
}

export async function updateDreamingEnabled(
  state: DreamingState,
  config: DreamingConfigCapability,
  enabled: boolean,
  canDispatch: () => boolean = () => true,
): Promise<boolean> {
  if (state.dreamingModeSaving || !canDispatch()) {
    return false;
  }
  if (!config.state.configSnapshot?.hash) {
    state.dreamingStatusError = t("dreaming.actions.configHashMissing");
    return false;
  }
  const { pluginId } = resolveConfiguredDreaming(
    asRecord(config.state.configSnapshot?.config) ?? null,
  );
  // "unknown" stays optimistic: the gateway rejects the write if it is wrong.
  if ((await resolveDreamingConfigPathSupport(config, pluginId)) === "unsupported") {
    const message = t("dreaming.actions.unsupportedPlugin", { pluginId });
    state.dreamingStatusError = message;
    state.lastError = message;
    return false;
  }
  if (
    state.dreamingModeSaving ||
    !canDispatch() ||
    !canCallDreamingMethod(state, "config.patch", "operator.admin")
  ) {
    return false;
  }
  state.dreamingModeSaving = true;
  state.dreamingStatusError = null;
  let updated: boolean;
  try {
    updated = await config.patch({
      raw: {
        plugins: {
          entries: {
            [pluginId]: {
              config: {
                dreaming: {
                  enabled,
                },
              },
            },
          },
        },
      },
      note: "Dreaming settings updated from the Dreaming tab.",
      canDispatch,
    });
    if (!updated) {
      state.dreamingStatusError =
        config.state.lastError ?? state.lastError ?? t("dreaming.actions.updateFailed");
    }
  } finally {
    state.dreamingModeSaving = false;
  }
  if (updated && state.dreamingStatus) {
    state.dreamingStatus = {
      ...state.dreamingStatus,
      enabled,
    };
  }
  return updated;
}
