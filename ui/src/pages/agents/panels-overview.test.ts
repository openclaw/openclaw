import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAgentContext } from "../../lib/agents/display.ts";
// Control UI tests cover the agents overview context display.
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { Agents } from "./view.tsx";

afterEach(() => document.body.replaceChildren());

const inheritedAgentModel = "openai/gpt-5.4";
const resolvedAgentWorkspace = "/tmp/agents/beta";

it.each([
  {
    name: "inherits a primary while preserving agent-owned fallbacks",
    model: { fallbacks: ["google/gemini-3-pro"] },
    expectedModel: `${inheritedAgentModel} (+1 fallback)`,
  },
  {
    name: "preserves explicitly disabled agent fallbacks",
    model: { fallbacks: [] },
    expectedModel: inheritedAgentModel,
  },
  {
    name: "prefers a dirty agent primary over stale roster and global models",
    model: { primary: "anthropic/claude-sonnet-4-6" },
    expectedModel: "anthropic/claude-sonnet-4-6",
  },
])("buildAgentContext $name", ({ model, expectedModel }) => {
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
        entries: { beta: { model } },
      },
    },
    null,
    "alpha",
  );

  expect(context.workspace).toBe(resolvedAgentWorkspace);
  expect(context.model).toBe(expectedModel);
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

it.each([
  { label: "a read-only editor", canUpdateIdentity: false, identitySaving: false },
  { label: "an active identity save", canUpdateIdentity: true, identitySaving: true },
])(
  "keeps identity field permissions correct for $label",
  ({ canUpdateIdentity, identitySaving }) => {
    const container = document.createElement("div");
    const props = createProps();
    mountSolid(
      Agents,
      {
        ...props,
        access: { ...props.access, canUpdateIdentity },
        overview: { ...props.overview, identitySaving },
      },
      container,
    );

    expect(
      container.querySelector<HTMLInputElement>(".agent-identity-editor__fields input")?.disabled,
    ).toBe(!canUpdateIdentity);
  },
);

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
    const container = document.body.appendChild(document.createElement("div"));
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
    const field = container.querySelector<HTMLElement>("openclaw-multi-select.agent-fallbacks");
    if (!field) {
      throw new Error("fallback field missing");
    }
    return { field, onModelFallbacksChange };
  }

  const choices = (field: HTMLElement) =>
    Array.from(
      field.querySelectorAll<HTMLElement>(".multi-select__option"),
      (row) => row.dataset.value,
    );
  const typeSearch = (field: HTMLElement, text: string) => {
    const input = field.querySelector<HTMLInputElement>("input")!;
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
  };
  const open = async (field: HTMLElement) => {
    field.querySelector<HTMLElement>(".multi-select")!.click();
    await waitForSolid(() => expect(choices(field).length).toBeGreaterThan(0));
  };

  it("shows the effective chain and excludes the primary and selected models from choices", async () => {
    const { field } = renderFallbacks();
    expect(
      Array.from(
        field.querySelectorAll<HTMLElement>(".multi-select__chip"),
        (chip) => chip.dataset.value,
      ),
    ).toEqual([existingFallback]);
    expect(field.querySelector<HTMLInputElement>("input")?.disabled).toBe(false);
    await open(field);
    expect(choices(field)).toEqual(["google/gemini-3-pro"]);
    typeSearch(field, "fixture/custom-fallback");
    expect(field.querySelector("[data-custom]")?.getAttribute("data-value")).toBe(
      "fixture/custom-fallback",
    );
  });

  it("stages the field's next chain for the selected agent", async () => {
    const { field, onModelFallbacksChange } = renderFallbacks();
    await open(field);
    field
      .querySelector<HTMLElement>('.multi-select__option[data-value="google/gemini-3-pro"]')!
      .click();
    expect(onModelFallbacksChange).toHaveBeenCalledWith("beta", [
      existingFallback,
      "google/gemini-3-pro",
    ]);
  });

  it("excludes a profile-qualified primary alias while retaining case-distinct model choices", async () => {
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

    await open(field);
    expect(choices(field)).toEqual([caseDistinct]);
    expect(field.querySelector(".multi-select__option")?.textContent).toContain("Uppercase model");
    typeSearch(field, "FAST");
    expect(choices(field)).toEqual([]);
    typeSearch(field, `${target}@other`);
    expect(choices(field)).toEqual([`${target}@other`]);
  });

  it("disables the field without config write access", () => {
    const access = { ...createProps().access, canUpdateConfig: false };
    const { field } = renderFallbacks({ access });

    expect(field.querySelector<HTMLInputElement>("input")?.disabled).toBe(true);
  });
});
