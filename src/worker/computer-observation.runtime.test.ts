import { describe, expect, it, vi } from "vitest";
import { createComputerTool, type ComputerToolTransport } from "../agents/tools/computer-tool.js";
import { createNoisyPngBuffer } from "../plugin-sdk/test-helpers/image-fixtures.js";
import type { ComputerActResult } from "../plugins/computer-use-contract.js";
import {
  createWorkerTranscriptRuntime,
  type WorkerTranscriptClient,
} from "./embedded-agent-transcript.runtime.js";

describe("worker computer observation persistence", () => {
  it.each(["screen", "window"] as const)(
    "commits a large %s observation with pixels only in image content",
    async (kind) => {
      const base64 = createNoisyPngBuffer(512, 512).toString("base64");
      expect(base64.length).toBeGreaterThan(64 * 1024);
      const providerResult = {
        ok: true,
        observation: {
          kind,
          base64,
          format: "png",
          width: 512,
          height: 512,
          observationId: `observation-${kind}`,
        },
      } satisfies ComputerActResult;
      const original = structuredClone(providerResult);
      const transport: ComputerToolTransport = {
        computerUse: {
          contractVersion: 2,
          provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
          actions: ["screenshot", "get_window_state"],
          targets: ["screen", "window"],
          deliveryModes: ["foreground"],
          observations: ["image"],
          features: { recording: false, agentCursor: false, multiDisplay: false },
        },
        resolveNode: async () => ({ nodeId: "desktop-node" }),
        invoke: async ({ command }) =>
          command === "screen.snapshot"
            ? { base64, displayFrameId: "display-frame", format: "png", width: 512, height: 512 }
            : providerResult,
      };
      const tool = createComputerTool({ transport });
      const result = await tool.execute(
        "observe",
        kind === "screen"
          ? { action: "screenshot" }
          : { action: "get_window_state", windowRef: "window-1" },
      );
      const commit = vi.fn<WorkerTranscriptClient["commit"]>(async (messages) => {
        expect(messages).toHaveLength(1);
        const message = messages[0];
        if (message?.role !== "toolResult") {
          throw new Error("The committed computer observation is missing");
        }
        const images = message.content.filter((part) => part.type === "image");
        expect(images).toHaveLength(1);
        expect(images[0]?.data.length).toBeGreaterThan(64 * 1024);
      });
      const transcript = createWorkerTranscriptRuntime({ commit });
      await transcript.withSessionWriteSettlement(() =>
        transcript.onMessagePersisted({
          role: "toolResult",
          toolName: "computer",
          toolCallId: "observe",
          content: result.content,
          details: result.details,
          isError: false,
          timestamp: 1,
        }),
      );

      expect(commit).toHaveBeenCalledOnce();
      expect(commit).toHaveBeenCalledWith([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({ type: "image", mimeType: "image/png" }),
          ]),
        }),
      ]);
      expect(result.content.filter((part) => part.type === "image")).toHaveLength(1);
      expect(JSON.stringify(result.details).includes(base64)).toBe(false);
      expect(providerResult).toEqual(original);
    },
  );
});
