import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { ONE_PIXEL_PNG_B64 } from "../agents/tools/image-tool.test-support.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import * as metadata from "../plugins/current-plugin-metadata-state.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { evaluateDecisionForTool, evaluateDecisionInRegistry } from "./runtime.js";
import { answer, batch, config, options, registered } from "./runtime.test-support.js";
import type { DecisionBatch, DecisionProviderV1 } from "./types.js";
import {
  DecisionContractError,
  validateDecisionBatch,
  validateDecisionResult,
} from "./validation.js";

const png = Uint8Array.from(Buffer.from(ONE_PIXEL_PNG_B64, "base64"));
const withImage: DecisionBatch = {
  ...batch,
  images: [{ mimeType: "image/png", data: png }],
};

afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearRuntimeConfigSnapshot();
});

it("admits bounded image bytes separately from the text/JSON budget", async () => {
  expect(validateDecisionBatch(withImage)).toBe(true);
  const oversized = new Uint8Array(4 * 1_048_576 + 1);
  oversized.set(png);
  expect(
    validateDecisionBatch({
      ...withImage,
      images: [{ mimeType: "image/png", data: oversized }],
    }),
  ).toBe(false);
  const nearLimit = new Uint8Array(4 * 1_048_576);
  nearLimit.set(png);
  expect(
    validateDecisionBatch({
      ...withImage,
      images: [
        { mimeType: "image/png", data: nearLimit },
        { mimeType: "image/png", data: nearLimit },
        { mimeType: "image/png", data: png },
      ],
    }),
  ).toBe(false);
  expect(
    validateDecisionBatch({
      ...withImage,
      images: Array.from({ length: 5 }, () => ({ mimeType: "image/png" as const, data: png })),
    }),
  ).toBe(false);
  expect(() =>
    validateDecisionBatch({
      ...withImage,
      images: [{ mimeType: "image/jpeg", data: png }],
    }),
  ).toThrow(DecisionContractError);
  expect(() =>
    validateDecisionBatch({
      ...withImage,
      images: [{ mimeType: "image/png", data: new Uint8Array(new SharedArrayBuffer(4)) }],
    }),
  ).toThrow(DecisionContractError);
  const oversizedPixels = Uint8Array.from(png);
  new DataView(oversizedPixels.buffer).setUint32(16, 8_193);
  const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
  const host = registered(evaluate);
  expect(
    await evaluateDecisionInRegistry(
      {
        ...withImage,
        images: [{ mimeType: "image/png", data: oversizedPixels }],
      },
      options(),
      host.registry,
      config,
    ),
  ).toEqual({ status: "unavailable", reason: "unsupported-input" });
  expect(evaluate).not.toHaveBeenCalled();
});

it("does not admit provider-added image or evidence fields into a result", () => {
  expect(validateDecisionResult(batch, { ...answer.result, image: "private image bytes" })).toBe(
    false,
  );
  expect(
    validateDecisionResult(batch, {
      ...answer.result,
      answers: {
        ...answer.result.answers,
        truth: { type: "boolean", probabilityTrue: 0.7, image: "private image bytes" },
      },
    }),
  ).toBe(false);
});

it("rejects images before dispatch unless the selected plugin model declares image input", async () => {
  const evaluate = vi.fn<DecisionProviderV1["evaluate"]>(async () => answer);
  const host = registered(evaluate);
  const snapshot = (image: boolean) =>
    createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "owner",
          contracts: { decisionProviders: ["fixture"] },
          decisionModels: [
            {
              provider: "fixture",
              id: "fixture-v1",
              name: "Fixture",
              capabilities: {
                questionTypes: ["boolean", "choice", "score"],
                ...(image ? { inputModalities: ["text", "image"] } : {}),
              },
            },
          ],
        },
      ],
    });
  const current = vi
    .spyOn(metadata, "getProcessGatewayPluginMetadataSnapshot")
    .mockReturnValue(snapshot(false));
  onTestFinished(() => current.mockRestore());
  expect(await evaluateDecisionInRegistry(withImage, options(), host.registry, config)).toEqual({
    status: "unavailable",
    reason: "unsupported-input",
  });
  expect(evaluate).not.toHaveBeenCalled();

  current.mockReturnValue(snapshot(true));
  expect(
    await evaluateDecisionInRegistry(withImage, options(), host.registry, config),
  ).toMatchObject({
    status: "ok",
  });
  expect(evaluate).toHaveBeenCalledOnce();
  const submitted = evaluate.mock.calls[0]![0];
  expect(submitted.images?.[0]?.data).toEqual(png);
  expect(submitted.images?.[0]?.data).not.toBe(png);
  setRuntimeConfigSnapshot(config);
  expect(
    await evaluateDecisionForTool(withImage, options(), {
      provider: "fixture",
      model: "previous-selection",
    }),
  ).toEqual({ status: "unavailable", reason: "disabled" });
  expect(evaluate).toHaveBeenCalledOnce();
});
