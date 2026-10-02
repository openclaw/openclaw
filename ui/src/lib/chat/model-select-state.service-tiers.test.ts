// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import {
  normalizeChatFastModeInput,
  resolveChatFastModeSelectState,
} from "./model-select-state.ts";

type FastModeSelectInput = Parameters<typeof resolveChatFastModeSelectState>[0];

function resolveFastModeSelection(
  input: Pick<FastModeSelectInput, "sessionsResult"> & Partial<FastModeSelectInput>,
) {
  return resolveChatFastModeSelectState({
    activeRunId: null,
    catalog: [],
    connected: true,
    currentModelOverride: "",
    fastModeTarget: input.sessionsResult?.sessions[0],
    gatewayAvailable: true,
    loading: false,
    sending: false,
    stream: null,
    ...input,
  });
}

describe("chat-model-select-state service tiers", () => {
  it.each(["codex", "openclaw"])(
    "requires current %s runtime access before showing Ultrafast",
    (runtimeId) => {
      const otherRuntimeId = runtimeId === "codex" ? "openclaw" : "codex";
      const model = {
        id: "model",
        name: "Model",
        provider: "openai",
        available: true,
        agentRuntime: { id: runtimeId, source: "model" as const },
        supportsFastMode: true,
        serviceTiers: ["priority", "ultrafast"],
      };
      const input = {
        sessionsResult: createSessionsListResult({ model: "model", modelProvider: "openai" }),
        currentModelOverride: "openai/model",
        fastModeTarget: {
          model: "model",
          modelProvider: "openai",
          fastMode: "ultrafast" as const,
          agentRuntime: { id: runtimeId, source: "session" as const },
        },
      };
      expect(normalizeChatFastModeInput("ultrafast")).toBe("ultrafast");
      expect(resolveFastModeSelection({ ...input, catalog: [model] })).toMatchObject({
        ultrafastSupported: true,
        currentOverride: "ultrafast",
        label: "Ultrafast",
        active: true,
      });
      for (const catalog of [
        [],
        [{ ...model, supportsFastMode: false }],
        [{ ...model, serviceTiers: undefined }],
        [{ ...model, serviceTiers: ["priority"] }],
        [{ ...model, available: undefined }],
        [{ ...model, available: false }],
        [{ ...model, id: "another-model" }],
        [{ ...model, agentRuntime: { id: otherRuntimeId, source: "model" as const } }],
      ]) {
        expect(resolveFastModeSelection({ ...input, catalog })).toMatchObject({
          ultrafastSupported: false,
          currentOverride: "ultrafast",
          label: "Fast",
        });
      }
      // Runtime alternatives are complete projections, not overlays on the base route.
      const catalog = [
        {
          ...model,
          runtimeChoices: [
            {
              agentRuntime: { id: otherRuntimeId, source: "model" as const },
              available: true,
              supportsFastMode: true,
            },
          ],
        },
      ];
      expect(
        resolveFastModeSelection({
          ...input,
          catalog,
          fastModeTarget: {
            ...input.fastModeTarget,
            agentRuntime: { id: otherRuntimeId, source: "session" },
          },
        }),
      ).toMatchObject({ ultrafastSupported: false, label: "Fast" });
      expect(
        resolveFastModeSelection({
          ...input,
          catalog: [
            {
              ...model,
              serviceTiers: undefined,
              runtimeChoices: [
                {
                  agentRuntime: { id: otherRuntimeId, source: "model" },
                  available: true,
                  supportsFastMode: true,
                  serviceTiers: ["priority", "ultrafast"],
                },
              ],
            },
          ],
          fastModeTarget: {
            ...input.fastModeTarget,
            agentRuntime: { id: otherRuntimeId, source: "session" },
          },
        }),
      ).toMatchObject({ ultrafastSupported: true, label: "Ultrafast" });
    },
  );
});
