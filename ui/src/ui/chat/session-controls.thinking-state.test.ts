import { describe, expect, it } from "vitest";
import type { AppViewState } from "../app-view-state.ts";
import { resolveChatThinkingSelectState } from "./session-controls.ts";

function createState(overrides: Partial<AppViewState> = {}): AppViewState {
  return {
    sessionKey: "session-1",
    chatModelCatalog: [],
    sessionsResult: {
      ts: 0,
      path: "sessions.json",
      count: 1,
      sessions: [
        {
          key: "session-1",
          kind: "direct",
          modelProvider: "openai",
          model: "gpt-5",
          updatedAt: null,
          thinkingLevel: undefined,
          thinkingDefault: "high",
          thinkingLevels: [
            { id: "off", label: "Off" },
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
      ],
      defaults: {
        modelProvider: "openai",
        model: "gpt-5",
        contextTokens: null,
        thinkingDefault: "medium",
        thinkingLevels: [
          { id: "off", label: "Off" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
        ],
      },
    },
    ...overrides,
  } as unknown as AppViewState;
}

describe("resolveChatThinkingSelectState", () => {
  it("shows inherited effective thinking when no session override is set", () => {
    const result = resolveChatThinkingSelectState(createState());

    expect(result.currentOverride).toBe("");
    expect(result.defaultLabel).toBe("Inherited: high");
    expect(result.options.map((entry) => entry.label)).toEqual([
      "Off",
      "Override: low",
      "Override: high",
    ]);
  });

  it("keeps the blank option pointed at the inherited level when an override is active", () => {
    const result = resolveChatThinkingSelectState(
      createState({
        sessionsResult: {
          ts: 0,
          path: "sessions.json",
          count: 1,
          sessions: [
            {
              key: "session-1",
              kind: "direct",
              modelProvider: "openai",
              model: "gpt-5",
              updatedAt: null,
              thinkingLevel: "low",
              thinkingDefault: "high",
              thinkingLevels: [
                { id: "off", label: "Off" },
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
            },
          ],
          defaults: {
            modelProvider: "openai",
            model: "gpt-5",
            contextTokens: null,
            thinkingDefault: "medium",
            thinkingLevels: [
              { id: "off", label: "Off" },
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
            ],
          },
        },
      }),
    );

    expect(result.currentOverride).toBe("low");
    expect(result.defaultLabel).toBe("Inherited: high");
    expect(result.options.find((entry) => entry.value === "low")?.label).toBe("Override: low");
  });

  it("renders Off when the effective default is truly off", () => {
    const result = resolveChatThinkingSelectState(
      createState({
        sessionsResult: {
          ts: 0,
          path: "sessions.json",
          count: 1,
          sessions: [
            {
              key: "session-1",
              kind: "direct",
              modelProvider: "openai",
              model: "gpt-5",
              updatedAt: null,
              thinkingLevel: undefined,
              thinkingDefault: "off",
              thinkingLevels: [{ id: "off", label: "Off" }],
            },
          ],
          defaults: {
            modelProvider: "openai",
            model: "gpt-5",
            contextTokens: null,
            thinkingDefault: "off",
            thinkingLevels: [{ id: "off", label: "Off" }],
          },
        },
      }),
    );

    expect(result.defaultLabel).toBe("Off");
    expect(result.options).toEqual([{ value: "off", label: "Off" }]);
  });
});
