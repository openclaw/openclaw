import { describe, expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { updatePickers, openPicker } from "../../test-helpers/select-picker.ts";
import { baseProps } from "./config-view.test-support.tsx";
import {
  buildSessionObserverTogglePatch,
  buildSessionObserverUtilityModelPatch,
  type SessionObserverModelSelection,
} from "./session-observer-settings.ts";
import { SidebarPreferencesSection } from "./view-appearance-preferences.tsx";

const fallbacks = ["fixture/backup"];
const current = { primary: "fixture/utility", fallbacks };
const selections: SessionObserverModelSelection[] = [
  { kind: "auto" },
  { kind: "disabled" },
  { kind: "model", model: "openai/gpt-5-mini" },
];
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
    expect(selections.map((selection) => buildSessionObserverUtilityModelPatch(selection))).toEqual(
      [null, "", "openai/gpt-5-mini"].map(utilityPatch),
    );
  });

  it("preserves the utility chain when changing its primary or restoring automatic routing", () => {
    const patches = selections.map((selection) =>
      buildSessionObserverUtilityModelPatch(selection, current),
    );
    expect(patches).toEqual(
      [null, "", "openai/gpt-5-mini"].map((primary) => utilityPatch({ primary, fallbacks })),
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
    const options = [...select.querySelectorAll('[role="option"]')];
    const option = (label: string) =>
      options
        .find((candidate) => candidate.textContent?.trim() === label)
        ?.getAttribute("aria-disabled");
    expect(select?.querySelector<HTMLButtonElement>("button")?.disabled).toBe(false);
    expect([option("Auto (provider default)"), option("Disabled"), option("GPT Mini")]).toEqual([
      "false",
      "false",
      "true",
    ]);
    expect(container.textContent).toContain("Explicit model catalog unavailable");
  });

  it.each([
    [{ id: "claude-cli", kind: "cli", label: "Claude CLI" }, " · Claude CLI · native"],
    [{ id: "openclaw", kind: "api", label: "OpenClaw Default" }, " · API · OpenClaw"],
    [{ id: "codex", kind: "harness", label: "OpenAI Codex" }, " · OpenAI Codex"],
    [undefined, ""],
  ] as const)("names the resolved small model's route for %o", (runtime, suffix) => {
    const model = "openai/gpt-5-mini";
    const container = renderObserver({
      sessionObserverResolvedModel: { status: "auto", model, ...(runtime ? { runtime } : {}) },
    });
    expect(container.textContent).toContain(`auto (${model}${suffix})`);
  });
});
