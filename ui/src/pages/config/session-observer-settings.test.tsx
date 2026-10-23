import { describe, expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { updatePickers, openPicker } from "../../test-helpers/select-picker.ts";
import { baseProps } from "./config-view.test-support.tsx";
import {
  buildSessionObserverTogglePatch,
  buildSessionObserverUtilityModelPatch,
} from "./session-observer-settings.ts";
import { SidebarPreferencesSection } from "./view-appearance-preferences.tsx";

const utilityPatch = (utilityModel: unknown) => ({ agents: { defaults: { utilityModel } } });

function renderObserver(overrides: Partial<Parameters<typeof SidebarPreferencesSection>[0]>) {
  return mountSolid(() =>
    SidebarPreferencesSection({
      ...baseProps(),
      sessionObserverEnabled: true,
      sessionObserverUtilityModel: undefined,
      sessionObserverModels: [],
      sessionObserverModelsUnavailable: false,
      sessionObserverDisabled: false,
      setSessionObserverEnabled: async () => true,
      setSessionObserverUtilityModel: async () => true,
      ...overrides,
    }),
  ).container;
}

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
    expect(buildSessionObserverUtilityModelPatch({ kind: "auto" })).toEqual(utilityPatch(null));
    expect(buildSessionObserverUtilityModelPatch({ kind: "disabled" })).toEqual(utilityPatch(""));
    expect(
      buildSessionObserverUtilityModelPatch({ kind: "model", model: "openai/gpt-5-mini" }),
    ).toEqual(utilityPatch("openai/gpt-5-mini"));
  });

  it("preserves the utility chain when changing its primary or restoring automatic routing", () => {
    const current = { primary: "fixture/utility", fallbacks: ["fixture/backup"] };
    expect(
      buildSessionObserverUtilityModelPatch({ kind: "model", model: "fixture/next" }, current),
    ).toEqual(utilityPatch({ primary: "fixture/next", fallbacks: ["fixture/backup"] }));
    expect(buildSessionObserverUtilityModelPatch({ kind: "auto" }, current)).toEqual(
      utilityPatch({ primary: null, fallbacks: ["fixture/backup"] }),
    );
    expect(buildSessionObserverUtilityModelPatch({ kind: "disabled" }, current)).toEqual(
      utilityPatch({ primary: "", fallbacks: ["fixture/backup"] }),
    );
  });

  it("keeps auto and disabled selectable when explicit models are unavailable", async () => {
    const container = renderObserver({
      sessionObserverResolvedModel: { status: "unavailable" },
      sessionObserverModels: [{ id: "gpt-mini", name: "GPT Mini", provider: "openai" }],
      sessionObserverModelsUnavailable: true,
    });

    await updatePickers(container);
    const select = container.querySelector<HTMLElement>(
      "openclaw-select-picker.model-picker__select",
    )!;
    await openPicker(select);
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
      "openai/gpt-5-mini",
      { id: "openclaw", kind: "api", label: "OpenClaw Default" },
      "auto (openai/gpt-5-mini · API · OpenClaw)",
    ],
    [
      "openai/gpt-5-mini",
      { id: "codex", kind: "harness", label: "OpenAI Codex" },
      "auto (openai/gpt-5-mini · OpenAI Codex)",
    ],
    ["anthropic/claude-haiku-4-5", undefined, "auto (anthropic/claude-haiku-4-5)"],
  ] as const)("names the resolved small model's route for %s on %o", (model, runtime, expected) => {
    const container = renderObserver({
      sessionObserverResolvedModel: { status: "auto", model, ...(runtime ? { runtime } : {}) },
    });
    expect(container.textContent).toContain(expected);
  });
});
