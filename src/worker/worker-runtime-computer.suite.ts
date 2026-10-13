import { expect, it } from "vitest";
import type {
  WorkerLiveEventParams,
  WorkerTranscriptCommitParams,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerComputerParams } from "../../packages/gateway-protocol/src/schema/worker-computer.js";
import type { WorkerInferenceStartParams } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { createNoisyPngBuffer } from "../../test/helpers/image-fixtures.js";
import type { WorkerLaunchDescriptor } from "./launch-descriptor.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

type WorkerComputerFixture = {
  setup: (options: {
    inferencePlans: Array<"computer" | "text" | "error" | "cancelled">;
    computerSnapshot: string;
    computerCleanupFailure: boolean;
  }) => Promise<{
    gateway: {
      acceptedTranscriptRequests: WorkerTranscriptCommitParams[];
      applicationOrder: string[];
      computerRequests: WorkerComputerParams[];
      inferenceRequests: WorkerInferenceStartParams[];
      liveEventRequests: WorkerLiveEventParams[];
    };
    launch: WorkerLaunchDescriptor;
  }>;
};

export function registerWorkerComputerTests({ setup }: WorkerComputerFixture) {
  it.each([
    { computerCleanupFailure: false, terminal: "text" },
    { computerCleanupFailure: false, terminal: "error" },
    { computerCleanupFailure: false, terminal: "cancelled" },
    { computerCleanupFailure: true, terminal: "text" },
    { computerCleanupFailure: true, terminal: "error" },
    { computerCleanupFailure: true, terminal: "cancelled" },
  ] as const)(
    "keeps desktop images through RPC, transcript, and inference before closing (cleanup failure: $computerCleanupFailure, terminal: $terminal)",
    async ({ computerCleanupFailure, terminal }) => {
      const computerSnapshot = createNoisyPngBuffer(512, 512).toString("base64");
      expect(computerSnapshot.length).toBeGreaterThan(64 * 1024);
      const { gateway, launch } = await setup({
        inferencePlans: ["computer", terminal],
        computerSnapshot,
        computerCleanupFailure,
      });
      launch.assignment.toolAuthority.allowedToolNames = ["computer"];
      launch.assignment.computer = {
        nodeId: "worker-desktop",
        computerUse: {
          contractVersion: 2,
          provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
          actions: ["screenshot"],
          targets: ["screen"],
          deliveryModes: ["foreground"],
          observations: ["image"],
          features: { recording: false, agentCursor: false, multiDisplay: false },
        },
      };

      await expect(runWorkerDescriptor(launch)).resolves.toMatchObject({
        status: computerCleanupFailure || terminal !== "text" ? "failed" : "completed",
      });

      expect(gateway.computerRequests.map((request) => request.command)).toEqual([
        "screen.snapshot",
        "computer.act",
      ]);
      expect(JSON.parse(gateway.computerRequests[1]!.paramsJson)).toMatchObject({
        action: "__close_execution",
      });
      const screenshot = gateway.acceptedTranscriptRequests
        .flatMap((request) => request.messages)
        .find((message) => message.role === "toolResult" && message.toolName === "computer");
      expect(screenshot).toMatchObject({
        isError: false,
        content: expect.arrayContaining([expect.objectContaining({ type: "image" })]),
      });
      const image = screenshot?.content.find((part) => part.type === "image");
      expect(image?.type === "image" && image.data.length).toBeGreaterThan(64 * 1024);
      expect(gateway.inferenceRequests[1]?.context.messages).toContainEqual(screenshot);
      const computer = gateway.inferenceRequests[0]?.context.tools?.find(
        (tool) => tool.name === "computer",
      );
      expect(computer?.parameters).not.toHaveProperty("properties.node");
      expect(computer?.parameters).not.toHaveProperty("properties.gatewayToken");
      expect(gateway.applicationOrder.indexOf("computer:close")).toBeLessThan(
        gateway.applicationOrder.indexOf("live:lifecycle:finishing"),
      );
      if (computerCleanupFailure) {
        expect(gateway.liveEventRequests.at(-1)?.event.payload).toHaveProperty(
          "replayInvalid",
          true,
        );
      } else {
        expect(gateway.liveEventRequests.at(-1)?.event.payload).not.toHaveProperty("replayInvalid");
      }
      if (terminal === "cancelled") {
        expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
          kind: "lifecycle",
          payload: { phase: "finishing", stopReason: "aborted" },
        });
        expect(gateway.liveEventRequests.at(-1)?.event.payload).toHaveProperty(
          "error",
          expect.stringContaining("fixture inference cancelled"),
        );
        if (computerCleanupFailure) {
          expect(gateway.liveEventRequests.at(-1)?.event.payload).toHaveProperty(
            "error",
            expect.stringContaining("fixture desktop cleanup failed"),
          );
        } else {
          expect(gateway.liveEventRequests.at(-1)?.event.payload).not.toHaveProperty(
            "error",
            expect.stringContaining("desktop cleanup failed"),
          );
        }
      } else if (computerCleanupFailure) {
        expect(gateway.liveEventRequests.at(-1)?.event).toMatchObject({
          kind: "lifecycle",
          payload: {
            phase: "finishing",
            stopReason: "error",
            error: expect.stringContaining(
              "computer: session desktop cleanup failed | fixture desktop cleanup failed",
            ),
          },
        });
        if (terminal === "error") {
          expect(gateway.liveEventRequests.at(-1)?.event.payload).toMatchObject({
            error: expect.stringContaining("fixture provider failed"),
          });
        }
      }
    },
  );
}
