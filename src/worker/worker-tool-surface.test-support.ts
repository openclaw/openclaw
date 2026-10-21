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

type WorkerToolFixture = {
  assignment: WorkerLaunchDescriptor["assignment"];
  config?: OpenClawConfig;
  sessionId: string;
  runId?: string;
};

export function prepareWorkerPlacementForTest(params: WorkerToolFixture) {
  const { assignment, config, sessionId } = params;
  const { agentId, permissionMode, workspaceDir: cwd } = assignment;
  const policy = prepareCoreToolPolicy({
    config,
    agentId,
    modelProvider: assignment.modelRef.provider,
    modelId: assignment.modelRef.model,
    sessionPermissionPolicy: permissionMode ? { mode: permissionMode, root: cwd } : undefined,
  });
  const tools = createWorkerPlacementTools({
    policy,
    cwd,
    containmentRoot: assignment.workerContainmentRoot ?? cwd,
    execAuthority: assignment.toolAuthority.exec,
    permissionMode,
    agentId,
    sessionKey: `worker:${sessionId}`,
    sessionId,
    runId: params.runId ?? assignment.runId,
  });
  return { policy, tools };
}

export function createWorkerToolSurfaceForTest(params: WorkerToolFixture): WorkerToolSurface {
  const { assignment } = params;
  const { policy, tools } = prepareWorkerPlacementForTest(params);
  type SurfaceTool = WorkerToolSurface["tools"][number];
  const entries = new Map<string, SurfaceTool>();
  const add = (
    definition: SurfaceTool["definition"],
    execution: SurfaceTool["execution"] = "placement",
    replay?: true,
  ) =>
    entries.set(definition.name, {
      id: definition.name,
      definition,
      execution,
      ...(replay ? { replay } : {}),
    });
  tools.forEach((tool) => add(projectAgentToolDefinition(tool)));
  if (assignment.browser) {
    add({
      name: "browser",
      label: "Browser",
      description: "Control the attached worker browser.",
      parameters: Type.Object({}),
      executionMode: undefined,
    });
  }
  if (assignment.computer) {
    add(
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
    const definition = { name, label: name, description, parameters, executionMode: undefined };
    add(
      definition,
      "gateway",
      name === "sessions_spawn" || name === "sessions_send" ? true : undefined,
    );
  }
  const surface = {
    generation: "runtime-surface",
    presentation: createToolSurfacePresentationForTest(),
    policy,
    tools: assignment.toolAuthority.allowedToolNames.flatMap((name) => {
      const entry = entries.get(name);
      return entry ? [entry] : [];
    }),
  };
  if (!Value.Check(WorkerToolSurfaceSchema, surface)) {
    throw new Error("Invalid test tool surface");
  }
  return surface;
}
