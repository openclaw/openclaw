import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, type Mock } from "vitest";
import type { ImageGenerationProvider } from "../../image-generation/provider-types.js";
import { encodePngRgba } from "../../media/png-encode.js";
import type { AnyAgentTool } from "./common.js";
import { withHeldMediaGenerationResult } from "./media-generation-lifecycle.test-support.js";

/** Real tool entry points share the original provider and task fixtures. */
export function defineImageGenerationIdentityTests(params: {
  setup: (
    root: string,
    firstBytes: Buffer,
  ) => {
    tool: AnyAgentTool;
    generate: Mock<ImageGenerationProvider["generateImage"]>;
    tasks: Parameters<typeof withHeldMediaGenerationResult>[1];
  };
  resultDetails: (result: Awaited<ReturnType<AnyAgentTool["execute"]>>) => Record<string, unknown>;
}) {
  const { resultDetails } = params;
  it.each(["reference", "same-path contents", "model", "options"])(
    "starts corrected image work for changed %s but dedupes an exact retry",
    async (changed) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-request-identity-"));
      const firstBytes = encodePngRgba(Buffer.from([255, 0, 0, 255]), 1, 1);
      const secondBytes = encodePngRgba(Buffer.from([0, 0, 255, 255]), 1, 1);
      const firstPath = path.join(root, "reference.png");
      const secondPath = path.join(root, "corrected.png");
      await fs.writeFile(firstPath, firstBytes);
      await fs.writeFile(secondPath, secondBytes);
      const { tool, generate, tasks: taskRuntimeMocks } = params.setup(root, firstBytes);
      const request = { prompt: "Keep this character, change the background", image: firstPath };
      try {
        await withHeldMediaGenerationResult(generate, taskRuntimeMocks, async (complete) => {
          const first = await tool.execute("first", request);
          const repeat = await tool.execute("retry", request);
          expect(resultDetails(repeat).duplicateGuard).toBe(true);
          expect(taskRuntimeMocks.createOperation).toHaveBeenCalledTimes(1);
          if (changed === "same-path contents") {
            await fs.writeFile(firstPath, secondBytes);
          }
          const corrected = {
            ...request,
            ...(changed === "reference" ? { image: secondPath } : {}),
            ...(changed === "model" ? { model: "openai/gpt-image-1-mini" } : {}),
            ...(changed === "options" ? { openai: { moderation: "low" } } : {}),
          };
          const second = await tool.execute("correction", corrected);
          expect(resultDetails(second).duplicateGuard).toBeUndefined();
          expect(taskRuntimeMocks.createOperation).toHaveBeenCalledTimes(2);
          expect(
            resultDetails(await tool.execute("corrected-retry", corrected)).duplicateGuard,
          ).toBe(true);
          await complete(2);
          expect(generate).toHaveBeenCalledTimes(2);
          expect(generate.mock.calls[0]?.[0].inputImages?.[0]?.buffer).toEqual(firstBytes);
          const expectedBytes =
            changed === "reference" || changed === "same-path contents" ? secondBytes : firstBytes;
          expect(generate.mock.calls[1]?.[0].inputImages?.[0]?.buffer).toEqual(expectedBytes);
          expect(generate.mock.calls[1]?.[0].model).toBe(
            changed === "model" ? "gpt-image-1-mini" : "gpt-image-1",
          );
          if (changed === "options") {
            expect(generate.mock.calls[1]?.[0].providerOptions?.openai?.moderation).toBe("low");
          }
          for (const [receipt, bytes] of [
            [first, firstBytes],
            [second, expectedBytes],
          ] as const) {
            expect(resultDetails(receipt).referenceInputs).toEqual([
              {
                sha256: createHash("sha256").update(bytes).digest("hex"),
                bytes: bytes.byteLength,
                mimeType: "image/png",
              },
            ]);
          }
        });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
}
