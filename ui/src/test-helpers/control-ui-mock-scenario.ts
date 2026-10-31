import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import {
  defaultControlUiFeatureMethods,
  createControlUiDefaultResponses,
} from "./control-ui-e2e-defaults.ts";
import { getSharedControlUiE2ePreview } from "./control-ui-e2e-shared-preview.ts";
import type { ControlUiMockGatewayScenario } from "./control-ui-e2e.ts";
import { normalizeControlUiMockAuth } from "./control-ui-mock-auth.ts";
import type { ControlUiSessionFixture } from "./control-ui-session-fixtures.ts";

export type NormalizedControlUiMockGatewayScenario = Required<
  Omit<
    ControlUiMockGatewayScenario,
    "nativePlugins" | "awaitInitialRoster" | "bootstrapPreferences"
  >
> &
  Pick<ControlUiMockGatewayScenario, "bootstrapPreferences">;

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
    controlUiTabs: scenario.controlUiTabs ?? [],
    controlUiWidgetKinds: scenario.controlUiWidgetKinds ?? [],
    controlUiLinkReaders: scenario.controlUiLinkReaders ?? [],
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
