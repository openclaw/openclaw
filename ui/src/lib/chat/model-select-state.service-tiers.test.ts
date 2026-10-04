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
        [{ ...model, available: undefined }],
        [{ ...model, available: false }],
        [{ ...model, id: "another-model" }],
        [{ ...model, agentRuntime: { id: otherRuntimeId, source: "model" as const } }],
      ]) {
        expect(resolveFastModeSelection({ ...input, catalog })).toMatchObject({
          ultrafastSupported: undefined,
          currentOverride: "ultrafast",
          label: "Ultrafast",
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
      ).toMatchObject({ ultrafastSupported: undefined, label: "Ultrafast" });
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

it("uses Standard for a model's authoritative Standard-only capability without confusing configured tiers", () => {
  for (const fastMode of [true, "auto", "ultrafast", undefined] as const) {
    const input = {
      sessionsResult: createSessionsListResult({ model: "standard-only", modelProvider: "openai" }),
      currentModelOverride: "openai/standard-only",
      fastModeTarget: { model: "standard-only", modelProvider: "openai", fastMode },
      catalog: [
        {
          id: "standard-only",
          name: "Standard model",
          provider: "openai",
          available: true,
          supportsFastMode: false,
          serviceTiers: ["default"],
        },
      ],
    };
    expect(resolveFastModeSelection(input)).toMatchObject({
      active: false,
      currentOverride: "off",
      label: "Standard",
      disabled: true,
      supported: true,
      ultrafastSupported: false,
    });
    expect(
      resolveFastModeSelection({
        ...input,
        catalog: input.catalog.map((entry) =>
          Object.assign({}, entry, {
            serviceTiers: ["priority", "ultrafast"],
          }),
        ),
      }),
    ).toMatchObject({ disabled: !fastMode });
  }
});

it.each([{ tiers: ["default", "priority"] }, { tiers: ["priority"] }])(
  "downgrades saved Ultrafast when the selected route offers $tiers",
  ({ tiers }) => {
    const state = resolveFastModeSelection({
      sessionsResult: null,
      currentModelOverride: "openai/fast-only",
      fastModeTarget: { model: "fast-only", modelProvider: "openai", fastMode: "ultrafast" },
      catalog: [
        {
          id: "fast-only",
          name: "Fast model",
          provider: "openai",
          supportsServiceTierRecovery: true,
          available: true,
          supportsFastMode: true,
          serviceTiers: tiers,
        },
      ],
    });
    expect(state).toMatchObject({
      active: true,
      currentOverride: "on",
      label: "Fast",
      disabled: false,
      ultrafastSupported: false,
    });
  },
);

it.each([{ tiers: ["default"] }, { tiers: [] }])(
  "shows Standard after the selected account loses optional tiers: $tiers",
  ({ tiers }) => {
    const state = resolveFastModeSelection({
      sessionsResult: null,
      currentModelOverride: "openai/account-limited",
      fastModeTarget: { model: "account-limited", modelProvider: "openai", fastMode: "ultrafast" },
      catalog: [
        {
          id: "account-limited",
          name: "Account-limited model",
          provider: "openai",
          supportsServiceTierRecovery: true,
          available: true,
          supportsFastMode: true,
          serviceTiers: tiers,
        },
      ],
    });
    expect(state).toMatchObject({
      active: false,
      currentOverride: "off",
      label: "Standard",
      disabled: true,
      supported: true,
      ultrafastSupported: false,
    });
  },
);

it.each([{ tiers: ["priority"] }, { tiers: ["default"] }, { tiers: [] }])(
  "does not invent tier recovery for a different harness with $tiers",
  ({ tiers }) => {
    const state = resolveFastModeSelection({
      sessionsResult: null,
      currentModelOverride: "openai/other-harness",
      fastModeTarget: {
        model: "other-harness",
        modelProvider: "openai",
        fastMode: "ultrafast",
        agentRuntime: { id: "codex", source: "session" },
      },
      catalog: [
        {
          id: "other-harness",
          name: "Other harness",
          provider: "openai",
          available: true,
          supportsFastMode: true,
          serviceTiers: tiers,
          agentRuntime: { id: "codex", source: "model" },
        },
      ],
    });
    expect(state).toMatchObject({
      active: true,
      currentOverride: "ultrafast",
      label: "Ultrafast",
      ultrafastSupported: false,
    });
  },
);

it.each([false, undefined])(
  "preserves the wire preference without route recovery capability %s",
  (supportsServiceTierRecovery) => {
    const state = resolveFastModeSelection({
      sessionsResult: null,
      currentModelOverride: "openai/custom-endpoint",
      fastModeTarget: { model: "custom-endpoint", modelProvider: "openai", fastMode: "ultrafast" },
      catalog: [
        {
          id: "custom-endpoint",
          name: "Custom endpoint",
          provider: "openai",
          available: true,
          agentRuntime: { id: "openclaw", source: "model" },
          supportsFastMode: true,
          supportsServiceTierRecovery,
          serviceTiers: ["priority"],
        },
      ],
    });
    expect(state).toMatchObject({
      currentOverride: "ultrafast",
      label: "Ultrafast",
      ultrafastSupported: false,
    });
  },
);
