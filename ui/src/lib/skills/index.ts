import type {
  SkillsDetailResult,
  SkillsSecurityVerdictsResult,
  SkillsSkillCardResult,
} from "@openclaw/gateway-protocol";
import { readClawHubTrustErrorDetails } from "../../../../packages/gateway-protocol/src/clawhub-trust-error-details.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type {
  AgentsListResult,
  SkillClawHubLink,
  SkillStatusEntry,
  SkillStatusReport,
} from "../../api/types.ts";
import {
  createConfigMutationRunner,
  type ConfigMutationOwner,
} from "../config/config-mutation-runner.ts";
import { formatUiError, formatUiExternalText } from "../format-error.ts";
import type { ClawHubSearchResult } from "./clawhub-search.ts";
import { loadSkillStatusReport } from "./status-report.ts";

export type ClawHubSkillDetail = SkillsDetailResult;
export type ClawHubSkillSecurityVerdict = SkillsSecurityVerdictsResult["items"][number];

const runSkillConfigMutation = createConfigMutationRunner(
  "Connection changed before the skill update started.",
);

export type SkillsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  runtimeConfig: ConfigMutationOwner;
  skillsAgentId: string | null;
  skillsAgentRevision: number;
  skillsLoading: boolean;
  skillsReport: SkillStatusReport | null;
  skillsError: string | null;
  skillsFilter: string;
  skillsStatusFilter: "all" | "ready" | "needs-setup" | "disabled";
  skillsDetailKey: string | null;
  skillsDetailTab: "overview" | "card";
  skillOperation: SkillOperation;
  skillEdits: Record<string, string>;
  skillMessages: Record<string, SkillMessage>;
  clawhubSearchQuery: string;
  clawhubSearchResults: ClawHubSearchResult[] | null;
  clawhubSearchLoading: boolean;
  clawhubSearchError: string | null;
  clawhubIconUrls: Record<string, string>;
  clawhubDetail: ClawHubSkillDetail | null;
  clawhubDetailRef: string | null;
  clawhubDetailLoading: boolean;
  clawhubDetailError: string | null;
  clawhubInstallMessage: {
    kind: "success" | "error";
    text: string;
  } | null;
  clawhubVerdicts: Record<string, ClawHubSkillSecurityVerdict>;
  clawhubVerdictsLoading: boolean;
  clawhubVerdictsError: string | null;
  skillCardContents: Record<string, string>;
  skillCardContentKeys: Record<string, string>;
  skillCardLoadingKey: string | null;
  skillCardErrors: Record<string, string>;
};

export type SkillOperation =
  | { kind: "refresh" }
  | { kind: "skill"; skillKey: string }
  | { kind: "clawhub"; ref: string }
  | null;

type ActiveSkillOperation = Exclude<SkillOperation, null>;

function ownsSkillOperation(
  state: SkillsState,
  client: GatewayBrowserClient,
  operation: ActiveSkillOperation,
): boolean {
  return state.connected && state.client === client && state.skillOperation === operation;
}

function releaseSkillOperation(state: SkillsState, operation: ActiveSkillOperation) {
  // Agent/source changes can outlive an owner request; identity keeps stale
  // cleanup from releasing a newer connection's operation.
  if (state.skillOperation === operation) {
    state.skillOperation = null;
  }
}

type SkillMessage = {
  kind: "success" | "error";
  message: string;
};

function setSkillMessage(state: SkillsState, key: string, message: SkillMessage) {
  if (!key.trim()) {
    return;
  }
  state.skillMessages = { ...state.skillMessages, [key]: message };
}

function getClawHubTrustDetailsFromError(err: unknown) {
  if (!err || typeof err !== "object" || !("details" in err)) {
    return undefined;
  }
  return readClawHubTrustErrorDetails(err.details);
}

const formatClawHubInstallMessage = (message: string, warning?: string): string =>
  warning ? `${message}\n\n${warning}` : message;

export function clawhubVerdictKey(target: {
  registry: string;
  slug: string;
  ownerHandle?: string;
  version: string;
}): string {
  return `${target.registry}\0${target.ownerHandle ?? ""}\0${target.slug}\0${target.version}`;
}

function isValidClawHubLink(
  link: SkillClawHubLink | undefined,
): link is Extract<SkillClawHubLink, { status: "linked"; valid: true }> {
  return Boolean(link && link.status === "linked" && link.valid);
}

function skillCardCacheKey(skill: SkillStatusEntry): string | undefined {
  if (!skill.skillCard?.present) {
    return undefined;
  }
  const installedVersion = isValidClawHubLink(skill.clawhub) ? skill.clawhub.installedVersion : "";
  return `${skill.skillCard.path}\0${skill.skillCard.sizeBytes}\0${installedVersion}`;
}

function currentSkillCardCacheKey(state: SkillsState, skillKey: string): string | undefined {
  const skill = state.skillsReport?.skills.find((entry) => entry.skillKey === skillKey);
  return skill ? skillCardCacheKey(skill) : undefined;
}

function stateSkillsAgentParams(state: Pick<SkillsState, "skillsAgentId">): { agentId?: string } {
  const agentId = state.skillsAgentId?.trim();
  return agentId ? { agentId } : {};
}

function captureSkillsAgentScope(
  state: Pick<SkillsState, "skillsAgentId" | "skillsAgentRevision">,
): () => boolean {
  const { skillsAgentId, skillsAgentRevision } = state;
  return () =>
    state.skillsAgentId === skillsAgentId && state.skillsAgentRevision === skillsAgentRevision;
}

export function setSkillsAgentId(state: SkillsState, agentId: string | null) {
  const nextAgentId = agentId?.trim() || null;
  if (state.skillsAgentId === nextAgentId) {
    return;
  }
  state.skillsAgentId = nextAgentId;
  state.skillsAgentRevision++;
  state.skillsLoading = false;
  state.skillsReport = null;
  state.skillsError = null;
  state.skillEdits = {};
  state.skillMessages = {};
  state.clawhubInstallMessage = null;
  state.clawhubVerdicts = {};
  state.clawhubVerdictsLoading = false;
  state.clawhubVerdictsError = null;
  state.skillCardContents = {};
  state.skillCardContentKeys = {};
  state.skillCardLoadingKey = null;
  state.skillCardErrors = {};
}

export function reconcileSkillsAgentId(
  state: SkillsState,
  agentsList: AgentsListResult | null | undefined,
) {
  if (!agentsList) {
    return;
  }
  const selectedAgentId = agentsList.agents.some((agent) => agent.id === state.skillsAgentId)
    ? state.skillsAgentId
    : agentsList.agents.some((agent) => agent.id === agentsList.defaultId)
      ? agentsList.defaultId
      : null;
  setSkillsAgentId(state, selectedAgentId);
}

export async function loadSkills(
  state: SkillsState,
  options?: {
    clearMessages?: boolean;
    operation?: Exclude<SkillOperation, null>;
  },
) {
  const client = state.client;
  const agentId = state.skillsAgentId?.trim();
  if (
    !client ||
    !agentId ||
    !state.connected ||
    state.skillsLoading ||
    (state.skillOperation && state.skillOperation !== options?.operation)
  ) {
    return;
  }
  if (options?.clearMessages && Object.keys(state.skillMessages).length > 0) {
    state.skillMessages = {};
  }
  const isCurrentAgent = captureSkillsAgentScope(state);
  const ownsLoad = () =>
    state.client === client &&
    isCurrentAgent() &&
    (!options?.operation || state.skillOperation === options.operation);
  const isCurrent = () => state.connected && ownsLoad();
  state.skillsLoading = true;
  state.skillsError = null;
  try {
    const res = await loadSkillStatusReport(client, agentId);
    if (!isCurrent()) {
      return;
    }
    if (res && Array.isArray(res.skills)) {
      state.skillsReport = res;
      pruneSkillCardState(state, res);
      void loadClawHubSecurityVerdicts(state, res);
    }
  } catch (err) {
    if (!isCurrent()) {
      return;
    }
    state.skillsError = formatUiError(err);
  } finally {
    // A transient disconnect invalidates the result, not this invocation's
    // loading ownership. Source/scope identity still protects newer loads.
    if (ownsLoad()) {
      state.skillsLoading = false;
    }
  }
}

async function loadCurrentSkillsForOperation(
  state: SkillsState,
  client: GatewayBrowserClient,
  operation: ActiveSkillOperation,
  clearMessages = false,
) {
  let shouldClearMessages = clearMessages;
  // Reconciliation can change scope while a status request is pending. Keep
  // the operation owner until one response belongs to the current scope.
  while (ownsSkillOperation(state, client, operation)) {
    const isCurrentAgent = captureSkillsAgentScope(state);
    await loadSkills(state, { clearMessages: shouldClearMessages, operation });
    shouldClearMessages = false;
    if (!ownsSkillOperation(state, client, operation) || isCurrentAgent()) {
      return;
    }
  }
}

export async function refreshSkills(state: SkillsState, loadAgents: () => Promise<void>) {
  const client = state.client;
  if (!client || !state.connected || state.skillsLoading || state.skillOperation) {
    return;
  }
  const operation = { kind: "refresh" } as const;
  // Reserve one operation across both awaits so a second refresh or write
  // cannot enter while agent discovery is still pending.
  state.skillOperation = operation;
  try {
    await loadAgents();
    if (!ownsSkillOperation(state, client, operation)) {
      return;
    }
    await loadCurrentSkillsForOperation(state, client, operation, true);
  } finally {
    releaseSkillOperation(state, operation);
  }
}

function pruneSkillCardState(state: SkillsState, report: SkillStatusReport) {
  const cacheKeys = new Map(
    report.skills
      .map((skill) => [skill.skillKey, skillCardCacheKey(skill)] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
  state.skillCardContents = Object.fromEntries(
    Object.entries(state.skillCardContents).filter(
      ([key]) => state.skillCardContentKeys[key] === cacheKeys.get(key),
    ),
  );
  state.skillCardContentKeys = Object.fromEntries(
    Object.entries(state.skillCardContentKeys).filter(
      ([key, value]) => value === cacheKeys.get(key),
    ),
  );
  state.skillCardErrors = Object.fromEntries(
    Object.entries(state.skillCardErrors).filter(([key]) => cacheKeys.has(key)),
  );
  if (state.skillCardLoadingKey && !cacheKeys.has(state.skillCardLoadingKey)) {
    state.skillCardLoadingKey = null;
  }
}

export async function loadSkillCard(state: SkillsState, skillKey: string) {
  if (
    !state.client ||
    !state.connected ||
    state.skillCardLoadingKey === skillKey ||
    (state.skillCardContents[skillKey] !== undefined &&
      state.skillCardContentKeys[skillKey] === currentSkillCardCacheKey(state, skillKey))
  ) {
    return;
  }
  const cacheKey = currentSkillCardCacheKey(state, skillKey);
  if (!cacheKey) {
    return;
  }
  const isCurrentAgent = captureSkillsAgentScope(state);
  const requestParams = { ...stateSkillsAgentParams(state), skillKey };
  state.skillCardLoadingKey = skillKey;
  const { [skillKey]: _previousError, ...nextErrors } = state.skillCardErrors;
  state.skillCardErrors = nextErrors;
  try {
    const response = await state.client.request<SkillsSkillCardResult>(
      "skills.skillCard",
      requestParams,
    );
    if (
      isCurrentAgent() &&
      response?.skillKey === skillKey &&
      typeof response.content === "string" &&
      currentSkillCardCacheKey(state, skillKey) === cacheKey
    ) {
      state.skillCardContents = { ...state.skillCardContents, [skillKey]: response.content };
      state.skillCardContentKeys = { ...state.skillCardContentKeys, [skillKey]: cacheKey };
    }
  } catch (err) {
    if (isCurrentAgent()) {
      state.skillCardErrors = {
        ...state.skillCardErrors,
        [skillKey]: formatUiError(err),
      };
    }
  } finally {
    if (isCurrentAgent() && state.skillCardLoadingKey === skillKey) {
      state.skillCardLoadingKey = null;
    }
  }
}

export async function loadClawHubSecurityVerdicts(state: SkillsState, report: SkillStatusReport) {
  const client = state.client;
  const isCurrentAgent = captureSkillsAgentScope(state);
  if (
    !client ||
    !state.connected ||
    !report.skills.some((skill) => isValidClawHubLink(skill.clawhub))
  ) {
    state.clawhubVerdicts = {};
    state.clawhubVerdictsLoading = false;
    state.clawhubVerdictsError = null;
    return;
  }
  state.clawhubVerdictsLoading = true;
  state.clawhubVerdictsError = null;
  try {
    const response = await client.request<SkillsSecurityVerdictsResult>(
      "skills.securityVerdicts",
      stateSkillsAgentParams(state),
    );
    if (!isCurrentAgent()) {
      return;
    }
    state.clawhubVerdicts = Object.fromEntries(
      (response?.items ?? []).map((item) => [
        clawhubVerdictKey({
          registry: item.registry,
          slug: item.requestedSlug,
          ownerHandle: item.requestedOwnerHandle,
          version: item.requestedVersion,
        }),
        item,
      ]),
    );
  } catch (err) {
    if (!isCurrentAgent()) {
      return;
    }
    state.clawhubVerdicts = {};
    state.clawhubVerdictsError = formatUiError(err);
  } finally {
    if (isCurrentAgent()) {
      state.clawhubVerdictsLoading = false;
    }
  }
}

export function updateSkillEdit(state: SkillsState, skillKey: string, value: string) {
  if (state.skillOperation || state.skillsLoading) {
    return;
  }
  state.skillEdits = { ...state.skillEdits, [skillKey]: value };
}

async function runSkillMutation(
  state: SkillsState,
  operation: Exclude<ActiveSkillOperation, { kind: "refresh" }>,
  run: (client: GatewayBrowserClient) => Promise<SkillMessage>,
) {
  const client = state.client;
  if (!client || !state.connected || state.skillsLoading || state.skillOperation) {
    return;
  }
  const isCurrentAgent = captureSkillsAgentScope(state);
  const isCurrent = () => ownsSkillOperation(state, client, operation) && isCurrentAgent();
  // All writes share one owner: overlapping refreshes can otherwise publish
  // a stale snapshot after both Gateway mutations have already succeeded.
  state.skillOperation = operation;
  if (operation.kind === "skill") {
    state.skillsError = null;
  } else {
    state.clawhubInstallMessage = null;
  }
  try {
    const message = await run(client);
    if (!isCurrent()) {
      return;
    }
    await loadSkills(state, { operation });
    if (!isCurrent()) {
      return;
    }
    if (operation.kind === "skill") {
      setSkillMessage(state, operation.skillKey, message);
    } else {
      state.clawhubInstallMessage = { kind: message.kind, text: message.message };
    }
  } catch (err) {
    if (!isCurrent()) {
      return;
    }
    const message = formatUiError(err);
    if (operation.kind === "skill") {
      state.skillsError = message;
      setSkillMessage(state, operation.skillKey, { kind: "error", message });
    } else {
      const trustDetails = getClawHubTrustDetailsFromError(err);
      state.clawhubInstallMessage = {
        kind: "error",
        text: formatClawHubInstallMessage(message, trustDetails?.warning),
      };
    }
  } finally {
    if (ownsSkillOperation(state, client, operation) && !isCurrentAgent()) {
      await loadCurrentSkillsForOperation(state, client, operation);
    }
    releaseSkillOperation(state, operation);
  }
}

export async function updateSkillEnabled(
  state: SkillsState,
  skillKey: string,
  enabled: boolean,
  canDispatch: () => boolean = () => true,
) {
  await runSkillConfigUpdate(
    state,
    skillKey,
    { enabled },
    enabled ? "Skill enabled" : "Skill disabled",
    canDispatch,
  );
}

async function runSkillConfigUpdate(
  state: SkillsState,
  skillKey: string,
  patch: { enabled: boolean } | { apiKey: string },
  message: string,
  canDispatch: () => boolean,
) {
  await runSkillMutation(state, { kind: "skill", skillKey }, async (client) => {
    const configPatch = { skillKey, ...patch };
    // Settings autosave and skills.update persist the same config; one owner
    // prevents a pending draft from restoring an older skill credential/toggle.
    const { refreshError } = await runSkillConfigMutation(
      state.runtimeConfig,
      client,
      (current) => current.request("skills.update", configPatch),
      { canDispatch, dispatchError: "Access changed before the skill update started." },
    );
    return { kind: "success", message: refreshError ? `${message}\n${refreshError}` : message };
  });
}

export async function saveSkillApiKey(
  state: SkillsState,
  skillKey: string,
  canDispatch: () => boolean = () => true,
) {
  // Blank skills.update API keys clear credentials; this UI only replaces them.
  const apiKey = state.skillEdits[skillKey]?.trim();
  if (!apiKey) {
    return;
  }
  await runSkillConfigUpdate(
    state,
    skillKey,
    { apiKey },
    `API key saved — stored in openclaw.json (skills.entries.${skillKey})`,
    canDispatch,
  );
}

export async function installSkill(
  state: SkillsState,
  skillKey: string,
  name: string,
  installId: string,
  dangerouslyForceUnsafeInstall = false,
) {
  await runSkillMutation(state, { kind: "skill", skillKey }, async (client) => {
    const result = await client.request<{ message?: string }>("skills.install", {
      ...stateSkillsAgentParams(state),
      name,
      installId,
      dangerouslyForceUnsafeInstall,
    });
    return {
      kind: "success",
      message: formatUiExternalText(result?.message, "Installed"),
    };
  });
}

export async function loadClawHubDetail(state: SkillsState, ref: string) {
  if (!state.client || !state.connected) {
    return;
  }
  const client = state.client;
  const isCurrentAgent = captureSkillsAgentScope(state);
  state.clawhubDetailRef = ref;
  state.clawhubDetailLoading = true;
  state.clawhubDetailError = null;
  state.clawhubDetail = null;
  const isCurrent = () =>
    state.connected &&
    state.client === client &&
    ref === state.clawhubDetailRef &&
    isCurrentAgent();
  try {
    const res = await client.request<ClawHubSkillDetail>("skills.detail", { slug: ref });
    if (!isCurrent()) {
      return;
    }
    state.clawhubDetail = res ?? null;
  } catch (err) {
    if (!isCurrent()) {
      return;
    }
    state.clawhubDetailError = formatUiError(err);
  }
  state.clawhubDetailLoading = false;
}

export function closeClawHubDetail(state: SkillsState) {
  state.clawhubDetailRef = null;
  state.clawhubDetail = null;
  state.clawhubDetailError = null;
  state.clawhubDetailLoading = false;
}

export async function installFromClawHub(state: SkillsState, ref: string, version?: string) {
  await runSkillMutation(state, { kind: "clawhub", ref }, async (client) => {
    const result = await client.request<{ message?: string; warning?: string }>("skills.install", {
      ...stateSkillsAgentParams(state),
      source: "clawhub",
      slug: ref,
      ...(version ? { version } : {}),
    });
    return {
      kind: "success",
      message: formatClawHubInstallMessage(
        formatUiExternalText(result?.message, `Installed ${ref}`),
        result?.warning ? formatUiExternalText(result.warning) : undefined,
      ),
    };
  });
}
