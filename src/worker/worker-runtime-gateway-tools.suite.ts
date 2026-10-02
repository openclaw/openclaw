import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";
import type { WorkerTranscriptCommitParams } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  WORKER_GATEWAY_TOOLS_PROTOCOL_FEATURE,
  type WorkerGatewayToolInvokeParams,
  type WorkerToolSurface,
} from "../../packages/gateway-protocol/src/schema/worker-gateway-tool.js";
import type { WorkerInferenceStartParams } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { runWorkerCommand } from "./worker-command.runtime.js";
import {
  buildWorkerProcessTurn,
  parseWorkerProcessMessage,
  type WorkerProcessResult,
} from "./worker-process-protocol.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

type WorkerGatewayToolFixture = {
  setup: (options?: {
    inferencePlans: Array<
      | "session-tool"
      | "text"
      | { args: Record<string, unknown>; toolCallId: string; toolName: string }
    >;
  }) => Promise<{
    gateway: {
      inferenceRequests: WorkerInferenceStartParams[];
      gatewayToolRequests: WorkerGatewayToolInvokeParams[];
      transcriptRequests: WorkerTranscriptCommitParams[];
      acceptedTranscriptRequests: WorkerTranscriptCommitParams[];
      connectionCount: number;
      toolSurface: () => WorkerToolSurface;
    };
    launch: WorkerLaunchDescriptor;
  }>;
};

export function registerWorkerGatewayToolAvailabilityTests({ setup }: WorkerGatewayToolFixture) {
  it("exposes exactly the Gateway-authorized worker tools", async () => {
    const { gateway, launch } = await setup();
    launch.assignment.toolAuthority.allowedToolNames = [
      "read",
      "exec",
      "sessions_spawn",
      "sessions_send",
      "portal",
    ];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests[0]?.context.tools?.map((tool) => tool.name)).toEqual([
      "read",
      "exec",
      "sessions_spawn",
      "sessions_send",
      "portal",
    ]);
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

  it("runs an authorized nested-session tool through the generic Gateway transport", async () => {
    const { gateway, launch } = await setup({ inferencePlans: ["session-tool", "text"] });
    launch.assignment.toolAuthority.allowedToolNames = ["sessions_spawn"];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.gatewayToolRequests).toEqual([
      {
        generation: "runtime-surface",
        toolId: "sessions_spawn",
        toolCallId: "nested-session-spawn-call",
        arguments: { task: "start a nested cloud child" },
      },
    ]);
    expect(gateway.inferenceRequests).toHaveLength(2);
    expect(
      gateway.transcriptRequests.flatMap((request) =>
        request.messages.flatMap((message) =>
          message.role === "toolResult" ? [message.toolName] : [],
        ),
      ),
    ).toContain("sessions_spawn");
  });

  it("returns Gateway presence to an authorized worker model through the generic Gateway transport", async () => {
    const args = { action: "person", person: "me", include: ["devices"] };
    const { gateway, launch } = await setup({
      inferencePlans: [{ toolName: "presence", toolCallId: "presence-read", args }, "text"],
    });
    launch.assignment.toolAuthority.allowedToolNames = ["presence"];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });
    expect(gateway.gatewayToolRequests).toEqual([
      {
        generation: "runtime-surface",
        toolId: "presence",
        toolCallId: "presence-read",
        arguments: args,
      },
    ]);
    const result = gateway.transcriptRequests
      .flatMap((request) => request.messages)
      .find((message) => message.role === "toolResult" && message.toolName === "presence");
    expect(result).toMatchObject({ details: { status: "ok", people: [{ name: "Ada" }] } });
  });
}
