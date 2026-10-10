import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { answer, batch, config, registered } from "../../decisions/runtime.test-support.js";
import type { DecisionProviderV1 } from "../../decisions/types.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshotState,
} from "../../plugins/current-plugin-metadata-state.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { parseDecisionEvaluateToolInput } from "./decision-tool-contract.js";
import { createDecisionTool } from "./decision-tool.js";

it("gives sanitized corrective guidance for malformed decision input", () => {
  const evidence = "PRIVATE_EVIDENCE_MARKER";
  expect(() =>
    parseDecisionEvaluateToolInput({ ...batch, state: evidence, images: [" "] }),
  ).toThrow(/one to four local image paths/);
  expect(() => parseDecisionEvaluateToolInput({ state: evidence, questions: {} })).toThrow(
    /nonempty questions map/,
  );
  for (const input of [
    { ...batch, state: evidence, images: [" "] },
    { state: evidence, questions: {} },
  ]) {
    try {
      parseDecisionEvaluateToolInput(input);
    } catch (error) {
      expect(String(error)).not.toContain(evidence);
    }
  }
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
  clearCurrentPluginMetadataSnapshot();
});

it("resolves one local screenshot through the core tool and dispatches bytes to an image-capable plugin", async () => {
  const root = tempDirs.make("decision-tool-image-");
  const screenshot = path.join(root, "screen.png");
  const expected = createSolidPngBuffer(3_000, 8, { r: 12, g: 34, b: 56 });
  fs.writeFileSync(screenshot, expected);
  const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
  registered(evaluate);
  setRuntimeConfigSnapshot(config);
  setCurrentPluginMetadataSnapshotState(
    createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "owner",
          contracts: { decisionProviders: ["fixture"] },
          decisionModels: [
            {
              provider: "fixture",
              id: "fixture-v1",
              name: "Image fixture",
              capabilities: {
                questionTypes: ["boolean", "choice", "score"],
                inputModalities: ["text", "image"],
              },
            },
          ],
        },
      ],
    }),
    undefined,
    undefined,
    undefined,
    undefined,
    "gateway",
  );
  const tool = createDecisionTool("main", {
    config,
    workspaceDir: root,
    fsPolicy: { workspaceOnly: true, root },
  });
  expect(tool).not.toBeNull();
  const result = await tool!.execute("call", { ...batch, images: [screenshot] });
  expect(result.details).toMatchObject({ status: "ok" });
  expect(evaluate).toHaveBeenCalledOnce();
  expect(evaluate.mock.calls[0]?.[0].images).toEqual([
    {
      mimeType: "image/png",
      data: Uint8Array.from(expected),
    },
  ]);
  expect(JSON.stringify(result)).not.toContain(screenshot);
  evaluate.mockClear();
  await expect(
    tool!.execute("remote", { ...batch, images: ["https://example.test/a.png"] }),
  ).rejects.toThrow("local image paths");
  expect(evaluate).not.toHaveBeenCalled();
  const oversizedSide = path.join(root, "oversized-side.png");
  fs.writeFileSync(oversizedSide, createSolidPngBuffer(8_193, 1, { r: 12, g: 34, b: 56 }));
  const rejected = await tool!.execute("oversized", { ...batch, images: [oversizedSide] });
  expect(rejected.details).toMatchObject({ status: "unavailable", reason: "unsupported-input" });
  expect(evaluate).not.toHaveBeenCalled();
});
