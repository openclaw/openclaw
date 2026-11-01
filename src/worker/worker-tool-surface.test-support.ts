import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { expect, it, vi } from "vitest";
import { PresenceQueryParamsSchema } from "../../packages/gateway-protocol/src/schema/presence.js";
import type {
  WorkerConnectRequestFrame,
  WorkerTranscriptCommitParams,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  validateWorkerExecApprovalParams,
  type WorkerExecApprovalParams,
} from "../../packages/gateway-protocol/src/schema/worker-exec-approval.js";
import {
  WorkerToolSurfaceSchema,
  WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE,
  type WorkerGatewayToolInvokeParams,
  type WorkerToolSurface,
} from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import type { WorkerInferenceStartParams } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
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
import { buildWorkerConnectParams, type WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { runWorkerCommand } from "./worker-command.runtime.js";
import { createWorkerConnection } from "./worker-connection.js";
import { workerExecApprovalDigest } from "./worker-exec-approval-binding.js";
import { createWorkerPlacementTools } from "./worker-placement-tools.js";
import {
  buildWorkerProcessTurn,
  parseWorkerProcessMessage,
  type WorkerProcessResult,
} from "./worker-process-protocol.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

export type WorkerExecFixtureOptions = {
  backgroundCommand?: string;
  backgroundYieldMs?: number;
  execCommand?: string;
  execApprovalDecision?: "allow-once" | "deny";
};

export abstract class WorkerExecApprovalFixture {
  abstract readonly methods: string[];
  readonly execApprovalRequests: WorkerExecApprovalParams[] = [];

  constructor(private readonly execOptions: WorkerExecFixtureOptions) {}

  protected handleExecApproval(frame: unknown, reply: (id: string, payload: object) => void) {
    if (
      !isRecord(frame) ||
      frame.type !== "req" ||
      typeof frame.id !== "string" ||
      frame.method !== "worker.exec.approval" ||
      !validateWorkerExecApprovalParams(frame.params)
    ) {
      return false;
    }
    const request = frame.params;
    const decision = this.execOptions.execApprovalDecision ?? "deny";
    this.methods.push(frame.method);
    this.execApprovalRequests.push(structuredClone(request));
    reply(frame.id, {
      operation: request.operation,
      binding: workerExecApprovalDigest(request.binding),
      ...(request.operation === "review"
        ? { decision: { decision, risk: "low", rationale: "Synthetic Gateway review" } }
        : request.operation === "request"
          ? { id: request.id, expiresAtMs: Date.now() + 60_000 }
          : { decision }),
    });
    return true;
  }
}

export function buildWorkerExecToolCall(
  fixture: WorkerExecFixtureOptions,
  options: { background: boolean; safe: boolean },
) {
  const args = options.background
    ? {
        // POSIX sleep avoids Node startup; Windows keeps the portable Node fixture.
        command:
          fixture.backgroundCommand ??
          (process.platform === "win32"
            ? `${JSON.stringify(process.execPath)} -e ${JSON.stringify(
                "setInterval(() => undefined, 1000)",
              )}`
            : "exec sleep 60"),
        ...(fixture.backgroundYieldMs === undefined
          ? { background: true }
          : { yieldMs: fixture.backgroundYieldMs }),
      }
    : {
        command:
          fixture.execCommand ?? (options.safe ? "wc -c" : "printf worker-local > local-proof.txt"),
      };
  return { args, toolCallId: "local-exec-call", toolName: "exec" };
}

export function createWorkerConnectionForTest(
  launch: WorkerLaunchDescriptor,
  options: Partial<Parameters<typeof createWorkerConnection>[0]> = {},
) {
  return createWorkerConnection({
    endpoint: launch.connectionEndpoint,
    connectParams: buildWorkerConnectParams(launch),
    ...options,
  });
}
export function createWorkerHelloForTest(
  admission: Omit<WorkerConnectRequestFrame["params"]["admission"], "runId">,
  toolSurface = createEmptyWorkerToolSurfaceForTest(),
  heartbeatIntervalMs = 60_000,
) {
  const { environmentId, sessionId, ownerEpoch, rpcSetVersion, handshake } = admission;
  return {
    type: "worker-hello-ok" as const,
    toolSurface,
    environmentId,
    sessionId,
    ownerEpoch,
    rpcSetVersion,
    protocolFeatures: [...handshake.protocolFeatures],
    credentialExpiresAtMs: Date.now() + 60_000,
    policy: { heartbeatIntervalMs, maxPayload: 25 * 1024 * 1024 },
  };
}

function createEmptyWorkerToolSurfaceForTest(): WorkerToolSurface {
  return {
    generation: "runtime-surface",
    presentation: createToolSurfacePresentationForTest(),
    policy: prepareCoreToolPolicy({}),
    tools: [],
  };
}

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
  const definitions = new Map(tools.map((tool) => [tool.name, projectAgentToolDefinition(tool)]));
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

type ToolCall = { toolName: string; toolCallId: string; args: Record<string, unknown> };
const toolCall = (toolName: string, toolCallId: string, args: ToolCall["args"]): ToolCall => ({
  toolName,
  toolCallId,
  args,
});
type WorkerGatewayToolFixture = {
  setup: (options?: { inferencePlans: Array<"text" | ToolCall> }) => Promise<{
    gateway: {
      inferenceRequests: WorkerInferenceStartParams[];
      gatewayToolRequests: WorkerGatewayToolInvokeParams[];
      transcriptRequests: WorkerTranscriptCommitParams[];
      acceptedTranscriptRequests: WorkerTranscriptCommitParams[];
      connectionCount: number;
      toolSurface: () => WorkerToolSurface;
    };
    launch: WorkerLaunchDescriptor;
    workspaceDir: string;
  }>;
};

export function registerWorkerGatewayToolAvailabilityTests({ setup }: WorkerGatewayToolFixture) {
  it.each(["direct", "code-mode", "directory"] as const)(
    "admits and executes Gateway tools with the %s presentation",
    async (mode) => {
      const codeMode = mode === "code-mode";
      const args = { url: "https://example.invalid/worker-tool-proof" };
      const { gateway, launch } = await setup({
        inferencePlans: [
          codeMode
            ? toolCall("exec", "gateway-fetch", {
                title: "Fetch the fixture page",
                code: `return await web_fetch(${JSON.stringify(args)})`,
              })
            : mode === "directory"
              ? toolCall("dispatch_action", "gateway-fetch", { id: "web_fetch", args })
              : toolCall("web_fetch", "gateway-fetch", args),
          "text",
        ],
      });
      const surface = gateway.toolSurface();
      surface.presentation = createToolSurfacePresentationForTest({
        tools: { codeMode, toolSearch: mode === "directory" ? { enabled: true, mode } : false },
      });
      const gatewayTool: WorkerToolSurface["tools"][number] = {
        id: "web_fetch",
        execution: "gateway",
        definition: {
          name: "web_fetch",
          label: "Web fetch",
          description: "Fetch a web page through the Gateway.",
          parameters: {
            type: "object",
            properties: { url: { type: "string" } },
            required: ["url"],
          },
        },
      };
      launch.assignment.toolAuthority.allowedToolNames = ["read"];
      let tools = [...surface.tools, gatewayTool];
      gateway.toolSurface = () => ({ ...surface, tools });

      await expect(runWorkerDescriptor(launch)).rejects.toThrow(
        "Worker tool surface exceeds launch authority: write",
      );
      expect(gateway.inferenceRequests).toHaveLength(0);
      expect(gateway.gatewayToolRequests).toHaveLength(0);

      tools = [...surface.tools.filter((tool) => tool.definition.name === "read"), gatewayTool];

      await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

      expect(gateway.inferenceRequests[0]?.context.tools?.map((tool) => tool.name)).toEqual(
        codeMode
          ? ["exec", "wait"]
          : mode === "directory"
            ? ["tool_search", "tool_describe", "dispatch_action", "read"]
            : ["read", "web_fetch"],
      );
      expect(gateway.gatewayToolRequests).toEqual([
        {
          generation: surface.generation,
          toolId: "web_fetch",
          toolCallId: mode === "direct" ? "gateway-fetch" : expect.stringContaining("web_fetch"),
          arguments: args,
        },
      ]);
    },
  );

  it("allows a contained write after exec refusal and still refuses a later workspace escape", async () => {
    const { gateway, workspaceDir, launch } = await setup({
      inferencePlans: [
        toolCall("exec", "refused-exec", { command: "printf forbidden > exec.txt" }),
        toolCall("write", "allowed-write", { path: "allowed.txt", content: "authorized" }),
        toolCall("write", "outside-write", { path: "../outside.txt", content: "forbidden" }),
        "text",
      ],
    });
    const contained = path.join(workspaceDir, "contained");
    await mkdir(contained);
    launch.assignment.workspaceDir = contained;
    launch.assignment.workerContainmentRoot = contained;
    launch.assignment.permissionMode = "guarded";

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });
    await expect(readFile(path.join(contained, "allowed.txt"), "utf8")).resolves.toBe("authorized");
    for (const denied of [
      path.join(contained, "exec.txt"),
      path.join(workspaceDir, "outside.txt"),
    ]) {
      await expect(stat(denied)).rejects.toMatchObject({ code: "ENOENT" });
    }
    const results = gateway.acceptedTranscriptRequests
      .flatMap((request) => request.messages)
      .filter((message) => message.role === "toolResult");
    expect(
      JSON.stringify(results.find((message) => message.toolCallId === "refused-exec")),
    ).toContain("SYSTEM_RUN_DENIED: approval cannot safely bind this command");
    expect(results.find((message) => message.toolCallId === "allowed-write")).toMatchObject({
      isError: false,
    });
    expect(results.find((message) => message.toolCallId === "outside-write")).toMatchObject({
      isError: true,
    });
    expect(gateway.inferenceRequests).toHaveLength(4);
  });

  it("rejects a Gateway without the admitted tool-surface capability before inference", async () => {
    const { gateway, launch } = await setup();
    launch.admission.handshake.protocolFeatures =
      launch.admission.handshake.protocolFeatures.filter(
        (feature) => feature !== WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE,
      );

    await expect(runWorkerDescriptor(launch)).rejects.toThrow(
      "Gateway does not support the admitted worker tool surface.",
    );
    expect(gateway.inferenceRequests).toHaveLength(0);
  });

  it("runs with no tools when the Gateway authority is empty", async () => {
    const { gateway, launch } = await setup();
    launch.assignment.toolAuthority.allowedToolNames = [];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests[0]?.context.tools ?? []).toEqual([]);
  });
}

export function registerWorkerGatewayToolRpcTests({ setup }: WorkerGatewayToolFixture) {
  it("refreshes Gateway tool catalogs and handles for each warm retained turn", async () => {
    const calls = [
      {
        toolName: "sessions_spawn" as const,
        toolCallId: "warm-spawn",
        args: { task: "start a nested cloud child" },
      },
      {
        toolName: "presence" as const,
        toolCallId: "warm-presence",
        args: { action: "person", person: "me", include: ["devices"] },
      },
    ];
    const { gateway, launch } = await setup({
      inferencePlans: calls.flatMap((call) => [call, "text" as const]),
    });
    launch.assignment.toolAuthority.allowedToolNames = calls.map((call) => call.toolName);
    const available = gateway.toolSurface();
    let surface = available;
    const admissions = vi.fn(() => surface);
    gateway.toolSurface = admissions;
    const input = new PassThrough();
    const output = new PassThrough();
    let pendingResult = createDeferred<WorkerProcessResult>();
    output.on("data", (chunk: Buffer) => {
      const message = parseWorkerProcessMessage(JSON.parse(chunk.toString("utf8")));
      if (message?.type === "result") {
        pendingResult.resolve(message);
      }
    });
    const command = runWorkerCommand({ managed: true, input, output });
    const settled = vi.fn();
    void command.then(
      () => {
        settled();
        pendingResult.reject(new Error("managed worker exited before its next result"));
      },
      (error: unknown) => {
        settled();
        pendingResult.reject(error);
      },
    );
    let transcript = launch.assignment.transcript;
    let retainedStateDir: string | undefined;
    try {
      for (const [index, call] of calls.entries()) {
        const next = structuredClone(launch);
        next.assignment.runId = `warm-run-${index}`;
        next.assignment.turnId = `warm-turn-${index}`;
        next.assignment.operationalRunInstance = createOperationalRunInstanceRef(
          next.assignment.runId,
        );
        next.assignment.agentRuntimeIdentityToken = `warm-runtime-token-${index}`;
        next.admission.credential = `warm-worker-credential-${index}`;
        next.assignment.toolAuthority.allowedToolNames = [call.toolName];
        next.assignment.transcript = transcript;
        next.assignment.initialMessages = gateway.acceptedTranscriptRequests.flatMap(
          (request) => request.messages,
        );
        surface = {
          ...available,
          generation: `warm-surface-${index}`,
          tools: available.tools.filter((tool) => tool.definition.name === call.toolName),
        };
        pendingResult = createDeferred<WorkerProcessResult>();
        input.write(`${JSON.stringify(buildWorkerProcessTurn(next, true))}\n`);
        const result = await pendingResult.promise;
        expect(result).toMatchObject({
          turnId: next.assignment.turnId,
          result: { status: "completed" },
          retainWorker: true,
          retention: "idle",
        });
        expect(settled).not.toHaveBeenCalled();
        retainedStateDir ??= process.env.OPENCLAW_STATE_DIR;
        expect(process.env.OPENCLAW_STATE_DIR).toBe(retainedStateDir);
        expect(
          gateway.inferenceRequests
            .filter((request) => request.runId === next.assignment.runId)
            .map((request) => request.context.tools?.map((tool) => tool.name)),
        ).toEqual([[call.toolName], [call.toolName]]);
        expect(gateway.gatewayToolRequests[index]).toEqual({
          generation: surface.generation,
          toolId: call.toolName,
          toolCallId: call.toolCallId,
          arguments: call.args,
        });
        const toolResult = gateway.transcriptRequests
          .flatMap((request) => request.messages)
          .find(
            (message) => message.role === "toolResult" && message.toolCallId === call.toolCallId,
          );
        expect(toolResult).toMatchObject({ toolName: call.toolName });
        if (call.toolName === "presence") {
          expect(toolResult).toMatchObject({
            details: { status: "ok", people: [{ name: "Ada" }] },
          });
        }
        if (result.result.status !== "completed") {
          throw new Error("Expected a completed warm worker turn");
        }
        transcript = {
          baseLeafId: result.result.transcriptLeafId,
          nextSeq: result.result.transcriptNextSeq,
        };
      }
      expect(admissions).toHaveBeenCalledTimes(2);
      expect(gateway.connectionCount).toBe(2);
      expect(gateway.gatewayToolRequests).toHaveLength(2);
    } finally {
      input.end();
      await command;
    }
  });
}
