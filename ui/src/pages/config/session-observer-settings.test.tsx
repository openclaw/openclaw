import { describe, expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { updatePickers } from "../../test-helpers/select-picker.ts";
import {
  buildSessionObserverTogglePatch,
  buildSessionObserverUtilityModelPatch,
} from "./session-observer-settings.ts";
import { SessionObserverSettings } from "./session-observer-settings.tsx";

describe("session observer settings patches", () => {
  it("uses null to restore the default toggle and false to opt out", () => {
    expect(buildSessionObserverTogglePatch(true)).toEqual({
      gateway: { controlUi: { sessionObserver: null } },
    });
    expect(buildSessionObserverTogglePatch(false)).toEqual({
      gateway: { controlUi: { sessionObserver: false } },
    });
  });

  it("distinguishes automatic, disabled, and explicit utility models", () => {
    expect(buildSessionObserverUtilityModelPatch({ kind: "auto" })).toEqual({
      agents: { defaults: { utilityModel: null } },
    });
    expect(buildSessionObserverUtilityModelPatch({ kind: "disabled" })).toEqual({
      agents: { defaults: { utilityModel: "" } },
    });
    expect(
      buildSessionObserverUtilityModelPatch({ kind: "model", model: "openai/gpt-5-mini" }),
    ).toEqual({
      agents: { defaults: { utilityModel: "openai/gpt-5-mini" } },
    });
  });

  it("keeps auto and disabled selectable when explicit models are unavailable", async () => {
    const container = document.createElement("div");
    mountSolid(
      () =>
        SessionObserverSettings({
          enabled: true,
          utilityModel: undefined,
          resolvedUtilityModel: { status: "unavailable" },
          models: [{ id: "gpt-mini", name: "GPT Mini", provider: "openai" }],
          modelsUnavailable: true,
          disabled: false,
          onEnabledChange: () => undefined,
          onUtilityModelChange: () => undefined,
        }),
      { container },
    );

    await updatePickers(container);
    const select = container.querySelector("openclaw-select-picker.model-picker__select");
    const options = [...(select?.querySelectorAll('[role="option"]') ?? [])];
    const option = (label: string) =>
      options.find((candidate) => candidate.textContent?.trim() === label);
    expect(select?.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
    expect(option("Auto (provider default)")?.getAttribute("aria-disabled")).toBe("false");
    expect(option("Disabled")?.getAttribute("aria-disabled")).toBe("false");
    expect(option("GPT Mini")?.getAttribute("aria-disabled") === "true").toBe(true);
    expect(container.textContent).toContain("Explicit model catalog unavailable");
  });

  it.each([
    [
      "anthropic/claude-haiku-4-5",
      { id: "claude-cli", kind: "cli", label: "Claude CLI" },
      "auto (anthropic/claude-haiku-4-5 · Claude CLI · native)",
    ],
    [
      "anthropic/claude-haiku-4-5",
      { id: "openclaw", kind: "api", label: "OpenClaw Default" },
      "auto (anthropic/claude-haiku-4-5 · API · OpenClaw)",
    ],
    [
      "openai/gpt-5-mini",
      { id: "openclaw", kind: "api", label: "OpenClaw Default" },
      "auto (openai/gpt-5-mini · API · OpenClaw)",
    ],
    [
      "openai/gpt-5-mini",
      { id: "codex", kind: "harness", label: "OpenAI Codex" },
      "auto (openai/gpt-5-mini · OpenAI Codex)",
    ],
    [
      "google/gemini-flash",
      { id: "google-gemini-cli", kind: "cli", label: "Gemini CLI" },
      "auto (google/gemini-flash · Gemini CLI · native)",
    ],
    [
      "haiku",
      { id: "openclaw", kind: "api", label: "OpenClaw Default" },
      "auto (haiku · API · OpenClaw)",
    ],
    ["anthropic/claude-haiku-4-5", undefined, "auto (anthropic/claude-haiku-4-5)"],
  ] as const)("names the resolved small model's route for %s on %o", (model, runtime, expected) => {
    const container = document.createElement("div");
    mountSolid(
      () =>
        SessionObserverSettings({
          enabled: true,
          utilityModel: undefined,
          resolvedUtilityModel: { status: "auto", model, ...(runtime ? { runtime } : {}) },
          models: [],
          modelsUnavailable: false,
          disabled: false,
          onEnabledChange: () => undefined,
          onUtilityModelChange: () => undefined,
        }),
      { container },
    );
    expect(container.textContent).toContain(expected);
  });
});
