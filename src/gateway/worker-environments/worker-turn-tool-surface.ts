import {
  copyAgentToolMetadata,
  getAgentToolExecutionLocation,
} from "../../agents/agent-tool-metadata.js";
import { createOpenClawCodingToolsInternalAsync } from "../../agents/agent-tools.js";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { acquireAgentRunPreparedModelRuntime } from "../../agents/prepared-model-runtime.js";
import { createLibrarySkillWorkshopTool } from "../../agents/tools/skill-workshop-tool-library.js";
import { logInfo } from "../../logger.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { createWorkerPlacementTools } from "../../worker/worker-placement-tools.js";
import type {
  prepareGitHubPublicationAvailability,
  prepareGitHubPullRequestReadAvailability,
} from "../github-publication-availability.js";
import type { prepareWorkerDesktopLaunchPlan } from "./worker-desktop-launch-plan.js";
import { createWorkerGatewayToolRuntime } from "./worker-gateway-tool-runtime.js";
import type { resolveWorkerToolAuthority } from "./worker-tool-authority.js";
import type { executeWorkerTurn } from "./worker-turn-execution.js";
import type { prepareWorkerAgentRuntimeIdentity } from "./worker-turn-payload.js";

type ExecutionParams = Parameters<typeof executeWorkerTurn>[0];

export function prepareWorkerTurnToolSurface(params: {
  turn: ExecutionParams["turn"];
  placement: ExecutionParams["placement"];
  environments: ExecutionParams["environments"];
  runtimeSnapshot: Awaited<ReturnType<typeof acquireAgentRunPreparedModelRuntime>>["snapshot"];
  toolAuthority: Awaited<ReturnType<typeof resolveWorkerToolAuthority>>;
  desktop: Awaited<ReturnType<typeof prepareWorkerDesktopLaunchPlan>>;
  modelRef: { provider: string; model: string };
  operationalRunInstance: Awaited<
    ReturnType<typeof prepareWorkerAgentRuntimeIdentity>
  >["operationalRunInstance"];
  launchToolNames: readonly string[];
  portalAvailable: boolean;
  githubPublicationAvailable: Awaited<ReturnType<typeof prepareGitHubPublicationAvailability>>;
  githubPullRequestReadAvailable: Awaited<
    ReturnType<typeof prepareGitHubPullRequestReadAvailability>
  >;
  signal: AbortSignal;
  assertCurrent: () => void;
}) {
  const {
    turn,
    placement,
    environments,
    runtimeSnapshot,
    desktop,
    modelRef,
    operationalRunInstance,
    launchToolNames,
    portalAvailable,
    githubPublicationAvailable,
    githubPullRequestReadAvailable,
    signal,
    assertCurrent,
  } = params;
  const {
    authProfileStoreSource,
    capabilityProfile,
    policy: toolPolicy,
    exec,
    execUnavailable,
    presentation,
    installedSkills,
  } = params.toolAuthority;
  const skillWorkshop = turn.skillLibraryAuthoring
    ? createLibrarySkillWorkshopTool({ ...turn.skillLibraryAuthoring, defaultTarget: "personal" })
    : undefined;
  return createWorkerGatewayToolRuntime({
    assertCurrent,
    signal,
    prepare: async (identity) => {
      const placementTools = createWorkerPlacementTools({
        ...turn,
        ...placement,
        policy: toolPolicy,
        cwd: placement.remoteWorkspaceDir,
        containmentRoot: placement.remoteWorkspaceDir,
        execAuthority: execUnavailable ? undefined : exec,
        sessionId: turn.sessionId,
      });
      placementTools.push(...desktop.tools);
      const availablePlacementTools = new Set(placementTools.map((tool) => tool.name));
      const tools = await withPluginRuntimeGenerationScope(runtimeSnapshot, () =>
        environments.createGatewayTools?.({
          identity,
          inheritedToolPolicySource: capabilityProfile.policy.inheritedToolPolicySource,
          skillWorkshop,
          portalAvailable,
          prepareTools: async (adapters) => {
            const prepared = await createOpenClawCodingToolsInternalAsync(
              {
                ...turn,
                authProfileStoreSource,
                agentId: placement.agentId,
                conversationCapabilityProfile: capabilityProfile,
                preparedModelRuntime: runtimeSnapshot,
                installedSkills,
                githubPublicationAvailable,
                githubPullRequestReadAvailable,
                cronCreatorAuthorityUnavailableReason: undefined,
                runSessionKey: placement.sessionKey,
                sessionKey: turn.sandboxSessionKey ?? placement.sessionKey,
                policyAgentId: turn.sandboxAgentId ?? turn.agentId,
                operationalRunInstance,
                sessionPermissionPolicy: turn.permissionMode
                  ? { mode: turn.permissionMode, root: turn.workspaceDir }
                  : undefined,
                modelProvider: modelRef.provider,
                modelId: modelRef.model,
                modelContextWindowTokens: toolPolicy.modelContextWindowTokens,
                runtimeToolAllowlist: turn.toolsAllow,
                skillWorkshop: undefined,
                computerTransport: null,
              },
              undefined,
              undefined,
              { tools: [...placementTools, ...adapters], policy: toolPolicy },
              { assertCurrent, signal },
            );
            if (turn.disableTools || turn.modelRun || turn.promptMode === "none") {
              return [];
            }
            return applyEmbeddedAttemptToolsAllow(prepared, turn.toolsAllow).filter((tool) => {
              const location = getAgentToolExecutionLocation(tool);
              const reason =
                location.kind === "gateway"
                  ? location.unavailableReason
                  : !availablePlacementTools.has(tool.name) || !launchToolNames.includes(tool.name)
                    ? "the placement has no available execution capability"
                    : undefined;
              if (reason) {
                logInfo(`Worker tool ${tool.name} withheld: ${reason}.`);
              }
              return !reason;
            });
          },
        }),
      );
      if (!tools) {
        throw new Error("Gateway tool surface is unavailable");
      }
      assertCurrent();
      return {
        policy: toolPolicy,
        presentation,
        tools: tools.map((tool) =>
          copyAgentToolMetadata(tool, {
            ...tool,
            execute: (...args) =>
              withPluginRuntimeGenerationScope(runtimeSnapshot, () => tool.execute(...args)),
          }),
        ),
      };
    },
  });
}
