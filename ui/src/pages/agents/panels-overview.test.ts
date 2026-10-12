import { describe, expect, it, vi } from "vitest";
import type { MultiSelect } from "../../components/multi-select.ts";
import { buildAgentContext } from "../../lib/agents/display.ts";
// Control UI tests cover the agents overview context display.
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { Agents } from "./view.tsx";

const inheritedAgentModel = "openai/gpt-5.4";
const resolvedAgentWorkspace = "/tmp/agents/beta";

it("prefers a dirty agent primary over stale roster and global models", () => {
  const context = buildAgentContext(
    {
      id: "beta",
      workspace: resolvedAgentWorkspace,
      model: { primary: "openai/stale-roster-model", fallbacks: ["openai/stale-fallback"] },
    },
    {
      agents: {
        defaults: {
          workspace: "/tmp/agents",
          model: { primary: inheritedAgentModel, fallbacks: ["openai/global-fallback"] },
        },
        entries: { beta: { model: { primary: "anthropic/claude-sonnet-4-6" } } },
      },
    },
    null,
    "alpha",
  );

  expect(context.workspace).toBe(resolvedAgentWorkspace);
  expect(context.model).toBe("anthropic/claude-sonnet-4-6");
});

it.each(["overview", "channels", "cron"] as const)(
  "shows authoritative agent workspace and effective model on the %s panel",
  (activePanel) => {
    const container = document.createElement("div");
    const props = createProps();
    mountSolid(
      Agents,
      {
        ...props,
        activePanel,
        agentsList: {
          defaultId: "alpha",
          mainKey: "main",
          scope: "per-sender",
          agents: [
            { id: "alpha", name: "Alpha" },
            {
              id: "beta",
              name: "Beta",
              workspace: resolvedAgentWorkspace,
              model: { primary: inheritedAgentModel },
            },
          ],
        },
        config: {
          ...props.config,
          configForm: {
            agents: {
              defaults: {
                workspace: "/tmp/agents",
                model: { primary: inheritedAgentModel, fallbacks: ["openai/global-fallback"] },
              },
              entries: { beta: { model: { fallbacks: ["google/gemini-3-pro"] } } },
            },
          },
        },
      },
      container,
    );

    const contextValue = (label: string) =>
      Array.from(container.querySelectorAll("dt"))
        .find((term) => term.textContent?.trim() === label)
        ?.nextElementSibling?.textContent?.trim();

    expect(contextValue("Workspace")).toBe(resolvedAgentWorkspace);
    expect(contextValue("Primary Model")).toBe(`${inheritedAgentModel} (+1 fallback)`);
  },
);

it("shows the active identity save state", () => {
  const container = document.createElement("div");
  const props = createProps();
  mountSolid(
    Agents,
    {
      ...props,
      access: { ...props.access, canUpdateIdentity: true },
      overview: { ...props.overview, identitySaving: true },
    },
    container,
  );

  const save = container.querySelector<HTMLButtonElement>(
    ".agent-identity-editor__actions button.primary",
  );
  expect(save?.textContent?.trim()).toBe("Saving…");
  expect(save?.disabled).toBe(true);
});

it("shows inherited skills in the Agent Context overview", () => {
  const container = document.createElement("div");
  mountSolid(
    Agents,
    createProps({
      config: {
        configForm: {
          agents: {
            defaults: { skills: ["github", "weather"] },
            entries: { beta: {} },
          },
        },
        configSnapshot: null,
        configLoading: false,
        configSaving: false,
        configFormDirty: false,
        lastError: null,
      },
    }),
    container,
  );

  const skillsFilterRow = Array.from(container.querySelectorAll("dt")).find(
    (term) => term.textContent?.trim() === "Skills Filter",
  )?.nextElementSibling;
  expect(skillsFilterRow?.textContent?.trim()).toBe("2 selected");
});

describe("fallback field", () => {
  const primary = "openai/gpt-5.4";
  const existingFallback = "anthropic/claude-sonnet-4-6";
  const catalog = [
    { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
    { id: "gemini-3-pro", name: "Gemini 3 Pro", provider: "google" },
  ] satisfies ReturnType<typeof createProps>["overview"]["modelCatalog"];

  function renderFallbacks(overrides: Partial<ReturnType<typeof createProps>> = {}) {
    const container = document.createElement("div");
    const onModelFallbacksChange = vi.fn();
    mountSolid(
      Agents,
      createProps({
        config: {
          configForm: {
            agents: {
              defaults: { model: { primary, fallbacks: [existingFallback] } },
              entries: { alpha: {}, beta: {} },
            },
          },
          configSnapshot: null,
          configLoading: false,
          configSaving: false,
          configFormDirty: false,
          lastError: null,
        },
        ...overrides,
        overview: {
          ...createProps().overview,
          modelCatalog: catalog,
          ...overrides.overview,
          onModelFallbacksChange,
        },
      }),
      container,
    );
    const field = container.querySelector<MultiSelect>("openclaw-multi-select.agent-fallbacks");
    if (!field) {
      throw new Error("fallback field missing");
    }
    return { field, onModelFallbacksChange };
  }

  it("stages the field's next chain for the selected agent", () => {
    const { field, onModelFallbacksChange } = renderFallbacks();

    expect(field.value).toEqual([existingFallback]);
    expect(field.isExcluded(primary)).toBe(true);
    expect(field.options.map((option) => option.value)).toEqual(
      expect.arrayContaining([primary, existingFallback, "google/gemini-3-pro"]),
    );
    expect(field.allowCustom).toBe(true);
    expect(field.disabled).toBe(false);
    field.onChange([existingFallback, "google/gemini-3-pro"]);

    expect(onModelFallbacksChange).toHaveBeenCalledWith("beta", [
      existingFallback,
      "google/gemini-3-pro",
    ]);
  });

  it("excludes a profile-qualified primary alias while retaining case-distinct model choices", () => {
    const primaryAlias = "fast@work";
    const target = "custom/model-a";
    const caseDistinct = "custom/Model-A";
    const { field } = renderFallbacks({
      agentsList: {
        defaultId: "alpha",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "alpha" }, { id: "beta", model: { primary: caseDistinct } }],
      },
      config: {
        configForm: {
          agents: {
            defaults: {
              model: { primary: primaryAlias },
              models: { [target]: { alias: "fast" } },
            },
            entries: { alpha: {}, beta: {} },
          },
        },
        configSnapshot: null,
        configLoading: false,
        configSaving: false,
        configFormDirty: false,
        lastError: null,
      },
      overview: {
        ...createProps().overview,
        modelCatalog: [
          { provider: "custom", id: "model-a", name: "Lowercase model" },
          { provider: "custom", id: "Model-A", name: "Uppercase model" },
        ],
      },
    });

    expect(field.isExcluded("FAST")).toBe(true);
    expect(field.isExcluded(`${target}@other`)).toBe(false);
    expect(field.options.filter((option) => !field.isExcluded(option.value))).toEqual([
      expect.objectContaining({ value: caseDistinct, label: "Uppercase model" }),
    ]);
  });
});
