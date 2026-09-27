import { expect, it } from "vitest";
import {
  WORKER_PORTAL_PROTOCOL_FEATURE,
  WORKER_PRESENCE_PROTOCOL_FEATURE,
  type WorkerPresenceParams,
  type WorkerSessionsSpawnParams,
  type WorkerTranscriptCommitParams,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInferenceStartParams } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
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
      presenceRequests: WorkerPresenceParams[];
      sessionSpawnRequests: WorkerSessionsSpawnParams[];
      transcriptRequests: WorkerTranscriptCommitParams[];
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

  it.each([
    { name: "portal", feature: WORKER_PORTAL_PROTOCOL_FEATURE },
    { name: "presence", feature: WORKER_PRESENCE_PROTOCOL_FEATURE },
  ] as const)(
    "hides $name when the admitted Gateway lacks its protocol support",
    async ({ name, feature }) => {
      const { gateway, launch } = await setup();
      launch.assignment.toolAuthority.allowedToolNames = ["read", name];
      launch.admission.handshake.protocolFeatures =
        launch.admission.handshake.protocolFeatures.filter((candidate) => candidate !== feature);

      await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

      expect(gateway.inferenceRequests[0]?.context.tools?.map((tool) => tool.name)).toEqual([
        "read",
      ]);
    },
  );

  it("runs with no tools when the Gateway authority is empty", async () => {
    const { gateway, launch } = await setup();
    launch.assignment.toolAuthority.allowedToolNames = [];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.inferenceRequests[0]?.context.tools ?? []).toEqual([]);
  });
}

export function registerWorkerGatewayToolRpcTests({ setup }: WorkerGatewayToolFixture) {
  it("runs an authorized nested-session tool through the closed worker RPC", async () => {
    const { gateway, launch } = await setup({ inferencePlans: ["session-tool", "text"] });
    launch.assignment.toolAuthority.allowedToolNames = ["sessions_spawn"];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });

    expect(gateway.sessionSpawnRequests).toEqual([
      {
        toolCallId: "nested-session-spawn-call",
        task: "start a nested cloud child",
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

  it("returns Gateway presence to an authorized worker model through the closed RPC", async () => {
    const args = { action: "person", person: "me", include: ["devices"] };
    const { gateway, launch } = await setup({
      inferencePlans: [{ toolName: "presence", toolCallId: "presence-read", args }, "text"],
    });
    launch.assignment.toolAuthority.allowedToolNames = ["presence"];

    await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({ status: "completed" });
    expect(gateway.presenceRequests).toEqual([{ ...args, toolCallId: "presence-read" }]);
    const result = gateway.transcriptRequests
      .flatMap((request) => request.messages)
      .find((message) => message.role === "toolResult" && message.toolName === "presence");
    expect(result).toMatchObject({ details: { status: "ok", people: [{ name: "Ada" }] } });
  });
}
