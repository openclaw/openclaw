import type { MessageReactionSummary } from "@openclaw/gateway-protocol";
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import type { ControlUiBootstrapConfig } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import type {
  AgentsListResult,
  ModelCatalogEntry,
  UpdateAvailable,
  UpdateScheduleState,
} from "../api/types.ts";
import type { MockGatewayRequestSelector } from "./control-ui-e2e-contract.ts";
import {
  defaultControlUiFeatureMethods,
  createControlUiDefaultResponses,
} from "./control-ui-e2e-defaults.ts";
import { getSharedControlUiE2ePreview } from "./control-ui-e2e-shared-preview.ts";
import { normalizeControlUiMockAuth, type ControlUiMockAuth } from "./control-ui-mock-auth.ts";
import type { ControlUiMockPresenceScenario } from "./control-ui-mock-presence.ts";
import type { NativeControlUiPluginFixture } from "./control-ui-plugin-fixture.ts";
import type { ControlUiSessionFixture } from "./control-ui-session-fixtures.ts";

export interface ControlUiMockGatewayScenario
  extends ControlUiMockAuth, ControlUiMockPresenceScenario {
  bootstrapPreferences?: ControlUiBootstrapConfig["preferences"];
  /** Auto-wait for sidebar rosters unless startup is held or connect fails; true overrides those skips, false disables the wait. */
  awaitInitialRoster?: boolean;
  nativePlugins?: readonly NativeControlUiPluginFixture[];
  pluginAssetsRequireAuth?: boolean;
  pluginSurfaceUrls?: Record<string, string>;
  attachmentMaxBytes?: number;
  agentModel?: string | null;
  assistantAgentId?: string;
  assistantName?: string;
  automaticallyFetchFavicons?: boolean;
  communityInvite?: boolean;
  basePath?: string;
  controlUiTabs?: Array<{
    group?: string;
    icon?: string;
    id: string;
    label: string;
    path?: string;
    placement?: string;
    pluginId: string;
    slug?: string;
  }>;
  controlUiLinkReaders?: unknown[];
  controlUiWidgetKinds?: Array<{
    kind: string;
    label: string;
    pluginId: string;
  }>;
  allowedSessionVisibilities?: Array<"shared" | "read-only" | "suggest" | "draft">;
  hasMultipleSessionSharingIdentities?: boolean;
  featureCapabilities?: string[];
  connectCapabilities?: string[];
  defaultAgentId?: string;
  deferredMethods?: string[];
  deferredRequests?: MockGatewayRequestSelector[];
  /** Hold every request until resolveDeferred/rejectDeferred releases the method. */
  heldMethods?: string[];
  /** Hold only requests matching these method and parameter selectors. */
  heldRequests?: MockGatewayRequestSelector[];
  /** Fail each admission-dependent read this many times before serving its normal response. */
  startupPendingResponses?: number;
  /** Non-release gateway checkout branch surfaced in the sidebar footer. */
  devGitBranch?: string;
  /** Exact immutable Control UI artifact served by the mocked Gateway. */
  serverBuildId?: string;
  /** Exact Gateway lifecycle generation served in hello. */
  gatewayBootId?: string;
  gatewaySuspensionPhase?: "accepting" | "preparing" | "draining" | "prepared";
  /** Optional startup update snapshot for rich local mock fixtures. */
  updateAvailable?: UpdateAvailable | null;
  /** Optional automatic-update campaign snapshot for rich local mock fixtures. */
  updateSchedule?: UpdateScheduleState | null;
  controlUiBuildSource?: "bundled" | "configured";
  serverVersion?: string;
  /** Startup-bound Gateway commit and build time; empty values are omitted from hello. */
  serverCommit?: string;
  serverBuiltAt?: string;
  featureEvents?: string[];
  featureMethods?: string[];
  /** Simulate a legacy Gateway that predates the advertised method catalog. */
  omitFeatureMethods?: boolean;
  historyMessages?: unknown[];
  /** Disable only for scenarios exercising the separate chat.startup fallback. */
  subscriptionInitialHistory?: boolean;
  sessionReactions?: Record<string, Record<string, MessageReactionSummary[]>>;
  /** Canonical per-session transcripts, shared by history and startup reads. */
  sessionTranscripts?: Record<
    string,
    {
      messages: unknown[];
      thinkingLevel?: string | null;
      inFlightRun?: ControlUiMockGatewayScenario["inFlightRun"];
    }
  >;
  maxPayload?: number;
  /** Static payloads, parameter-matched cases, or call-ordered sequences. */
  methodResponses?: Record<string, unknown>;
  /** URL prefixes that retain the browser's real WebSocket transport. */
  webSocketPassthroughPrefixes?: string[];
  /** Replayed in-flight run snapshot served by chat.history and chat.startup. */
  inFlightRun?: {
    runId: string;
    text?: string;
    startedAt?: number;
    events?: unknown[];
    plan?: unknown;
  } | null;
  /** Subscription-scoped Gateway events replayed on a fixed browser-side cycle. */
  repeatingSessionEvents?: {
    events: Array<{ event: "agent" | "session.observer" | "session.tool"; payload: unknown }>;
    intervalMs?: number;
  };
  /** Explicit history-only row override, for example a stale run-state projection. */
  sessionInfo?: Record<string, unknown> | null;
  /** Canonical fixture rows, independent of case/sequence/deferred wire overrides. */
  sessions?: ControlUiSessionFixture[];
  /** Partition sessions.list fixtures by archived state after applying patches. */
  sessionArchiveFiltering?: boolean;
  models?: ModelCatalogEntry[];
  /** Selected fixture and event default; use controlUiSessionUrl to select it in the UI. */
  sessionKey?: string;
  sessionScope?: AgentsListResult["scope"];
  mainSessionKey?: string;
  /** Initial gateway-owned custom group catalog (sessions.groups.*), in order. */
  sessionGroups?: string[];
  /** Optional New Session defaults keyed by custom group name. */
  sessionGroupDefaults?: Record<string, { cwd?: string; worktree?: boolean }>;
  terminalEnabled?: boolean;
  cliAgentsEnabled?: boolean;
  workspace?: string;
  workspaceGit?: boolean;
}

type ControlUiPluginHello = Required<
  Pick<
    ControlUiMockGatewayScenario,
    "controlUiTabs" | "controlUiWidgetKinds" | "controlUiLinkReaders" | "pluginSurfaceUrls"
  >
>;

export type NormalizedControlUiMockGatewayScenario = Required<
  Omit<
    ControlUiMockGatewayScenario,
    "nativePlugins" | "awaitInitialRoster" | "bootstrapPreferences" | keyof ControlUiPluginHello
  >
> &
  Pick<ControlUiMockGatewayScenario, "bootstrapPreferences"> & {
    controlUiPluginHello: ControlUiPluginHello;
    /** Running-Gateway identity in hello; unset commit and build time are omitted. */
    serverRelease: { version: string; commit?: string; builtAt?: string };
  };

const DEFAULT_MOCK_MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_MOCK_ATTACHMENT_MAX_BYTES = Math.floor(
  ((DEFAULT_MOCK_MAX_PAYLOAD_BYTES - 256 * 1024) * 3) / 4,
);

export function normalizeScenario(
  scenario: ControlUiMockGatewayScenario,
): NormalizedControlUiMockGatewayScenario {
  const sharedBuildInfo = getSharedControlUiE2ePreview()?.buildInfo;
  const defaultAgentId = normalizeAgentId(scenario.defaultAgentId);
  const mainSessionKey =
    scenario.mainSessionKey?.trim() ||
    (scenario.sessionScope === "global" ? "global" : `agent:${defaultAgentId}:main`);
  const sessionKey = scenario.sessionKey?.trim() || mainSessionKey;
  const staticList = scenario.methodResponses?.["sessions.list"] as
    | { sessions?: ControlUiSessionFixture[] }
    | undefined;
  const basePathValue = scenario.basePath?.trim() ?? "";
  const basePathWithSlash = basePathValue
    ? basePathValue.startsWith("/")
      ? basePathValue
      : `/${basePathValue}`
    : "";
  const basePath =
    basePathWithSlash.length > 1 && basePathWithSlash.endsWith("/")
      ? basePathWithSlash.slice(0, -1)
      : basePathWithSlash;
  return {
    bootstrapPreferences: scenario.bootstrapPreferences,
    pluginAssetsRequireAuth: scenario.pluginAssetsRequireAuth ?? true,
    attachmentMaxBytes: scenario.attachmentMaxBytes ?? DEFAULT_MOCK_ATTACHMENT_MAX_BYTES,
    automaticallyFetchFavicons: scenario.automaticallyFetchFavicons ?? false,
    communityInvite: scenario.communityInvite ?? false,
    agentModel:
      scenario.agentModel === undefined ? "openai/gpt-5.5" : scenario.agentModel?.trim() || null,
    assistantAgentId: scenario.assistantAgentId?.trim() || defaultAgentId,
    assistantName: scenario.assistantName?.trim() || "OpenClaw",
    basePath,
    controlUiPluginHello: {
      controlUiTabs: scenario.controlUiTabs ?? [],
      controlUiWidgetKinds: scenario.controlUiWidgetKinds ?? [],
      controlUiLinkReaders: scenario.controlUiLinkReaders ?? [],
      pluginSurfaceUrls: scenario.pluginSurfaceUrls ?? {},
    },
    allowedSessionVisibilities: scenario.allowedSessionVisibilities ?? [
      "shared",
      "read-only",
      "suggest",
      "draft",
    ],
    hasMultipleSessionSharingIdentities: scenario.hasMultipleSessionSharingIdentities ?? false,
    featureCapabilities: scenario.featureCapabilities ?? [],
    // This fixture answers catalog RPCs; snapshot scenarios publish their own events.
    connectCapabilities: scenario.connectCapabilities ?? [],
    defaultAgentId,
    deferredMethods: scenario.deferredMethods ?? [],
    deferredRequests: scenario.deferredRequests ?? [],
    heldMethods: scenario.heldMethods ?? [],
    heldRequests: scenario.heldRequests ?? [],
    startupPendingResponses: scenario.startupPendingResponses ?? 0,
    devGitBranch: scenario.devGitBranch?.trim() || "",
    serverBuildId: scenario.serverBuildId?.trim() || sharedBuildInfo?.buildId || "e2e",
    gatewayBootId: scenario.gatewayBootId?.trim() || "e2e-gateway-boot",
    gatewaySuspensionPhase: scenario.gatewaySuspensionPhase ?? "accepting",
    updateAvailable: scenario.updateAvailable ?? null,
    updateSchedule: scenario.updateSchedule ?? null,
    controlUiBuildSource: scenario.controlUiBuildSource ?? "bundled",
    serverVersion: scenario.serverVersion?.trim() || sharedBuildInfo?.version || "e2e",
    serverCommit: scenario.serverCommit ?? "",
    serverBuiltAt: scenario.serverBuiltAt ?? "",
    serverRelease: {
      version: scenario.serverVersion?.trim() || sharedBuildInfo?.version || "e2e",
      ...(scenario.serverCommit ? { commit: scenario.serverCommit } : {}),
      ...(scenario.serverBuiltAt ? { builtAt: scenario.serverBuiltAt } : {}),
    },
    ...normalizeControlUiMockAuth(scenario),
    featureEvents: scenario.featureEvents ?? [],
    // Baseline scenarios represent a current Gateway. Tests for unsupported or
    // mixed-version methods provide an explicit narrower catalog.
    featureMethods: scenario.featureMethods ?? [...defaultControlUiFeatureMethods],
    omitFeatureMethods: scenario.omitFeatureMethods ?? false,
    historyMessages: scenario.historyMessages ?? [],
    subscriptionInitialHistory: scenario.subscriptionInitialHistory ?? true,
    sessionReactions: scenario.sessionReactions ?? {},
    sessionTranscripts: scenario.sessionTranscripts ?? {},
    maxPayload: scenario.maxPayload ?? DEFAULT_MOCK_MAX_PAYLOAD_BYTES,
    mainSessionKey,
    methodResponses: { ...createControlUiDefaultResponses(scenario), ...scenario.methodResponses },
    webSocketPassthroughPrefixes: scenario.webSocketPassthroughPrefixes ?? [],
    inFlightRun: scenario.inFlightRun ?? null,
    presenceUsers: scenario.presenceUsers ?? [],
    emitPresenceOnConnect: scenario.emitPresenceOnConnect ?? true,
    models: scenario.models ?? [{ id: "gpt-5.5", name: "gpt-5.5", provider: "openai" }],
    repeatingSessionEvents: scenario.repeatingSessionEvents ?? { events: [] },
    sessionInfo: scenario.sessionInfo ?? null,
    sessions:
      scenario.sessions ??
      staticList?.sessions ??
      (staticList
        ? []
        : [
            {
              key: sessionKey === "main" ? mainSessionKey : sessionKey,
              label: "Main",
              kind:
                (sessionKey === "main" ? mainSessionKey : sessionKey) === "global"
                  ? "global"
                  : "direct",
              updatedAt: Date.now(),
            },
          ]),
    sessionArchiveFiltering: scenario.sessionArchiveFiltering ?? false,
    sessionKey,
    sessionScope: scenario.sessionScope ?? "per-sender",
    sessionGroups: scenario.sessionGroups ?? [],
    sessionGroupDefaults: scenario.sessionGroupDefaults ?? {},
    terminalEnabled: scenario.terminalEnabled ?? false,
    cliAgentsEnabled: scenario.cliAgentsEnabled ?? false,
    workspace: scenario.workspace ?? "",
    workspaceGit: scenario.workspaceGit ?? false,
  };
}
