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

type DreamingResourceValues = {
  dreamingStatus: DreamingStatus;
  dreamDiary: { path: string; content: string | null };
  wikiImportInsights: WikiImportInsights;
  wikiOverview: WikiOverview;
};
export type DreamingResourceKey = keyof DreamingResourceValues;
type DreamingResourceRequest = { agentId: string };
export type DreamingResources = {
  [Key in DreamingResourceKey]: {
    value: DreamingResourceValues[Key] | null;
    loading: boolean;
    error: string | null;
    agentId?: string | null;
    request?: DreamingResourceRequest;
  };
};

export type DreamingState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  configSnapshot: ConfigSnapshot | null;
  selectedAgentId: string | null;
  resources: DreamingResources;
  dreamingModeSaving: boolean;
  dreamDiaryActionLoading: boolean;
  dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null;
  dreamDiaryActionArchivePath: string | null;
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
    resources: {
      dreamingStatus: { value: null, loading: false, error: null },
      dreamDiary: { value: null, loading: false, error: null },
      wikiImportInsights: { value: null, loading: false, error: null },
      wikiOverview: { value: null, loading: false, error: null },
    },
    dreamingModeSaving: false,
    dreamDiaryActionLoading: false,
    dreamDiaryActionMessage: null,
    dreamDiaryActionArchivePath: null,
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
      return t(
        `dreaming.actions.dedupeRemoved${removed === 1 ? "One" : "Many"}${kept === undefined ? "" : "AndKept"}`,
        { removed: String(removed), ...(kept === undefined ? {} : { kept: String(kept) }) },
      );
    }
    case "doctor.memory.repairDreamingArtifacts": {
      const archiveDir = normalizeTrimmedString(payload?.archiveDir);
      const actions = (
        [
          [payload?.archivedSessionCorpus, "dreaming.actions.repairArchivedThreadCorpus"],
          [payload?.archivedSessionIngestion, "dreaming.actions.repairArchivedIngestionState"],
          [payload?.archivedDreamsDiary, "dreaming.actions.repairArchivedDreamDiary"],
        ] as const
      )
        .filter(([archived]) => archived === true)
        .map(([, label]) => t(label));
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
  value: (payload: DreamingResourcePayloads[Key]) => DreamingResourceValues[Key] | null;
};

const DREAMING_RESOURCES: {
  [Key in DreamingResourceKey]: DreamingResourceSpec<Key>;
} = {
  dreamingStatus: {
    method: "doctor.memory.status",
    value: (payload) => payload.dreaming ?? null,
  },
  dreamDiary: {
    method: "doctor.memory.dreamDiary",
    value: (payload) => ({
      path: payload.path,
      content: payload.found ? (payload.content ?? "") : null,
    }),
  },
  wikiImportInsights: { method: "wiki.importInsights", value: (payload) => payload },
  wikiOverview: { method: "wiki.overview", value: (payload) => payload },
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
  const resource = state.resources[key];
  if (!agentId) {
    return;
  }
  const client = state.client;
  if (!client || !state.connected) {
    return;
  }
  if (resource.agentId !== agentId) {
    resource.value = null;
  }
  if (
    (key === "wikiImportInsights" || key === "wikiOverview") &&
    !canCallMemoryWikiMethod(state, spec.method)
  ) {
    delete resource.request;
    resource.loading = false;
    resource.error = null;
    resource.value = null;
    return;
  }

  const active = resource.request;
  if (active?.agentId === agentId && resource.loading) {
    return;
  }

  // Request identity, not agent identity, rejects stale A -> B -> A completions.
  const request: DreamingResourceRequest = { agentId };
  resource.request = request;
  resource.loading = true;
  resource.error = null;
  try {
    const payload = await client.request<DreamingResourcePayloads[Key]>(spec.method, { agentId });
    if (resource.request !== request || resolveSelectedAgentId(state) !== agentId) {
      return;
    }
    resource.value = spec.value(payload);
    resource.agentId = agentId;
  } catch (error) {
    if (resource.request === request && resolveSelectedAgentId(state) === agentId) {
      resource.error = formatUiError(error);
    }
  } finally {
    if (resource.request === request) {
      delete resource.request;
      resource.loading = false;
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
  state.resources.dreamingStatus.error = null;
  state.resources.dreamDiary.error = null;
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
    state.resources.dreamingStatus.error = message;
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
    state.resources.dreamingStatus.error = t("dreaming.actions.configHashMissing");
    return false;
  }
  const { pluginId } = resolveConfiguredDreaming(
    asRecord(config.state.configSnapshot?.config) ?? null,
  );
  // "unknown" stays optimistic: the gateway rejects the write if it is wrong.
  if ((await resolveDreamingConfigPathSupport(config, pluginId)) === "unsupported") {
    const message = t("dreaming.actions.unsupportedPlugin", { pluginId });
    state.resources.dreamingStatus.error = message;
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
  state.resources.dreamingStatus.error = null;
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
      state.resources.dreamingStatus.error =
        config.state.lastError ?? state.lastError ?? t("dreaming.actions.updateFailed");
    }
  } finally {
    state.dreamingModeSaving = false;
  }
  if (updated && state.resources.dreamingStatus.value) {
    state.resources.dreamingStatus.value = {
      ...state.resources.dreamingStatus.value,
      enabled,
    };
  }
  return updated;
}
