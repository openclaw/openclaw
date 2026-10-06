import { Type } from "typebox";
import { Value } from "typebox/value";
import { PresenceQueryParamsSchema } from "../../packages/gateway-protocol/src/schema/presence.js";
import {
  WorkerToolSurfaceSchema,
  type WorkerToolSurface,
} from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import {
  prepareCoreToolPolicy,
  projectAgentToolDefinition,
} from "../agents/prepared-tool-surface.js";
import { createToolSurfacePresentationForTest } from "../agents/tool-surface-plan.test-support.js";
import {
  SessionPortalToolSchema,
  SESSION_PORTAL_TOOL_DESCRIPTION,
} from "../agents/tools/portal-tool-contract.js";
import { PRESENCE_TOOL_DESCRIPTION } from "../agents/tools/presence-tool-contract.js";
import {
  PlacedSessionsSendSchema,
  PlacedSessionsSpawnSchema,
  PLACED_SESSIONS_SEND_DESCRIPTION,
  PLACED_SESSIONS_SPAWN_DESCRIPTION,
} from "../agents/tools/sessions-placement-tool-contract.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createWorkerComputerTool } from "./computer-runtime.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { createWorkerPlacementTools } from "./worker-placement-tools.js";

export function createWorkerToolSurfaceForTest(params: {
  assignment: WorkerLaunchDescriptor["assignment"];
  config?: OpenClawConfig;
  sessionId: string;
}): WorkerToolSurface {
  const { assignment, config, sessionId } = params;
  const policy = prepareCoreToolPolicy({
    config,
    agentId: assignment.agentId,
    modelProvider: assignment.modelRef.provider,
    modelId: assignment.modelRef.model,
    ...(assignment.permissionMode
      ? {
          sessionPermissionPolicy: {
            mode: assignment.permissionMode,
            root: assignment.workspaceDir,
          },
        }
      : {}),
  });
  const definitions = new Map(
    createWorkerPlacementTools({
      policy,
      cwd: assignment.workspaceDir,
      containmentRoot: assignment.workerContainmentRoot ?? assignment.workspaceDir,
      execAuthority: assignment.toolAuthority.exec,
      permissionMode: assignment.permissionMode,
      agentId: assignment.agentId,
      sessionKey: `worker:${sessionId}`,
      sessionId,
      runId: assignment.runId,
    }).map((tool) => [tool.name, projectAgentToolDefinition(tool)]),
  );
  if (assignment.browser) {
    definitions.set("browser", {
      name: "browser",
      label: "Browser",
      description: "Control the attached worker browser.",
      parameters: Type.Object({}),
      executionMode: undefined,
    });
  }
  if (assignment.computer) {
    definitions.set(
      "computer",
      projectAgentToolDefinition(
        createWorkerComputerTool({
          descriptor: assignment.computer,
          runId: assignment.runId,
          requestComputer: async () => {
            throw new Error("Definition preparation cannot invoke the desktop");
          },
          registerRunCleanup: () => {},
        }),
      ),
    );
  }
  const gatewayDefinitions = [
    ["sessions_spawn", PlacedSessionsSpawnSchema, PLACED_SESSIONS_SPAWN_DESCRIPTION],
    ["sessions_send", PlacedSessionsSendSchema, PLACED_SESSIONS_SEND_DESCRIPTION],
    ["portal", SessionPortalToolSchema, SESSION_PORTAL_TOOL_DESCRIPTION],
    ["presence", PresenceQueryParamsSchema, PRESENCE_TOOL_DESCRIPTION],
  ] as const;
  for (const [name, parameters, description] of gatewayDefinitions) {
    definitions.set(name, {
      name,
      label: name,
      description,
      parameters,
      executionMode: undefined,
    });
  }
  const surface = {
    generation: "runtime-surface",
    presentation: createToolSurfacePresentationForTest(),
    policy,
    tools: assignment.toolAuthority.allowedToolNames.flatMap((name) => {
      const definition = definitions.get(name);
      if (!definition) {
        return [];
      }
      const gatewayTool = gatewayDefinitions.some(([toolName]) => toolName === name);
      return [
        {
          id: name,
          definition,
          execution: gatewayTool ? "gateway" : "placement",
          ...(name === "sessions_spawn" || name === "sessions_send"
            ? { replay: true as const }
            : {}),
        },
      ];
    }),
  };
  if (!Value.Check(WorkerToolSurfaceSchema, surface)) {
    throw new Error("Invalid test tool surface");
  }
  return surface;
}
