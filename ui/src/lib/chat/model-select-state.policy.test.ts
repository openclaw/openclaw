// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSessionsListResult } from "../../test-helpers/chat-model.ts";
import {
  resolveChatFastModeSelectState,
  resolveChatModelSelectState,
} from "./model-select-state.ts";

describe("chat-model-select-state", () => {
  it.each([false, true])(
    "retains current Fast support=%s without offering a denied model",
    (supportsFastMode) => {
      const catalog = [
        {
          id: "automatic",
          name: "Automatic model",
          provider: "anthropic",
          manualSelectionAllowed: false,
          supportsFastMode,
        },
        { id: "manual", name: "Manual model", provider: "anthropic", manualSelectionAllowed: true },
        { id: "legacy", name: "Older server model", provider: "anthropic" },
      ];
      const sessionsResult = createSessionsListResult({
        model: "automatic",
        modelProvider: "anthropic",
        defaultsModel: "automatic",
        defaultsProvider: "anthropic",
      });
      const selection = resolveChatModelSelectState({
        activeSession: sessionsResult.sessions[0],
        sessionKey: "main",
        modelOverrides: {},
        chatModelCatalog: catalog,
        sessionsResult,
      });
      expect(selection.options.map((option) => option.value)).toEqual([
        "anthropic/manual",
        "anthropic/legacy",
      ]);
      expect(selection.defaultLabel).toContain("Automatic model");
      expect(
        resolveChatFastModeSelectState({
          activeRunId: null,
          catalog,
          connected: true,
          currentModelOverride: "anthropic/automatic",
          fastModeTarget: sessionsResult.sessions[0],
          gatewayAvailable: true,
          loading: false,
          sending: false,
          sessionsResult,
          stream: null,
        }),
      ).toMatchObject({ supported: supportsFastMode, disabled: !supportsFastMode });
    },
  );
});
