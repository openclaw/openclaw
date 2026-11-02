import { afterEach, assert, expect, it, vi } from "vitest";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { Agents, type AgentsProps } from "./view.tsx";

afterEach(() => document.body.replaceChildren());

const inheritedAgentModel = "openai/gpt-5.4";
const existingFallback = "anthropic/claude-sonnet-4-6";
const nextFallback = "google/gemini-3-pro";
const resolvedAgentWorkspace = "/tmp/agents/beta";
const agentConfig = (defaults: Record<string, unknown>, beta: Record<string, unknown> = {}) => ({
  agents: { defaults, entries: { beta } },
});
const contextConfig = (model: Record<string, unknown>) =>
  agentConfig(
    {
      workspace: "/tmp/agents",
      skills: ["github", "weather"],
      model: { primary: inheritedAgentModel, fallbacks: ["openai/global-fallback"] },
    },
    { model },
  );
const data = createProps().readData();
const contextValue = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll("dt"))
    .find((term) => term.textContent?.trim() === label)
    ?.nextElementSibling?.textContent?.trim();

type ViewOverrides = Omit<Partial<AgentsProps>, "access" | "overview"> & {
  access?: Partial<AgentsProps["access"]>;
  overview?: Partial<AgentsProps["overview"]>;
  configForm?: Record<string, unknown>;
};
function renderAgents({ configForm, ...overrides }: ViewOverrides = {}) {
  const container = document.body.appendChild(document.createElement("div"));
  const defaults = createProps();
  return mountSolid(
    Agents,
    {
      ...defaults,
      ...overrides,
      config: overrides.config ?? { ...defaults.config, configForm: configForm ?? null },
      access: { ...defaults.access, ...overrides.access },
      overview: { ...defaults.overview, ...overrides.overview },
    },
    container,
  ).container;
}

it.each([
  ["overview", { fallbacks: [nextFallback] }, `${inheritedAgentModel} (+1 fallback)`],
  ["channels", { fallbacks: [] }, inheritedAgentModel],
  ["cron", { primary: existingFallback }, existingFallback],
] as const)(
  "shows authoritative workspace, skills and effective model on %s",
  async (panel, model, expectedModel) => {
    const container = renderAgents({
      configForm: contextConfig(model),
      readData: () => ({
        ...data,
        agentsPanel: panel,
        agentsList: {
          ...data.agentsList!,
          agents: [
            {
              id: "beta",
              workspace: resolvedAgentWorkspace,
              model: { primary: "openai/stale-roster-model", fallbacks: ["openai/stale-fallback"] },
            },
          ],
        },
      }),
    });
    await waitForSolid(() => {
      expect(contextValue(container, "Workspace")).toBe(resolvedAgentWorkspace);
      expect(contextValue(container, "Primary Model")).toBe(expectedModel);
      expect(contextValue(container, "Skills Filter")).toBe("2 selected");
    });
  },
);

it.each([false, true])(
  "keeps identity field permissions correct with write access %s",
  (canUpdateIdentity) => {
    const container = renderAgents({
      access: { canUpdateIdentity },
      readData: () => ({ ...data, identitySaving: canUpdateIdentity }),
    });

    expect(
      container.querySelector<HTMLInputElement>(".agent-identity-editor__fields input")?.disabled,
    ).toBe(!canUpdateIdentity);
  },
);

const catalog = [
  { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "gemini-3-pro", name: "Gemini 3 Pro", provider: "google" },
] satisfies ReturnType<typeof createProps>["overview"]["modelCatalog"];

function renderFallbacks(canUpdateConfig = true) {
  const onModelFallbacksChange = vi.fn();
  const container = renderAgents({
    configForm: agentConfig({
      model: { primary: inheritedAgentModel, fallbacks: [existingFallback] },
    }),
    access: { canUpdateConfig },
    overview: { modelCatalog: catalog, onModelFallbacksChange },
  });
  const field = container.querySelector<HTMLElement>("openclaw-multi-select.agent-fallbacks");
  assert(field, "Missing fallback field");
  return { field, input: field.querySelector<HTMLInputElement>("input"), onModelFallbacksChange };
}

const values = (field: HTMLElement, selector = ".multi-select__option") =>
  Array.from(field.querySelectorAll<HTMLElement>(selector), (row) => row.dataset.value);
const typeSearch = (field: HTMLElement, text: string) => {
  const input = field.querySelector<HTMLInputElement>("input")!;
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
};
const open = async (field: HTMLElement) => {
  field.querySelector<HTMLElement>(".multi-select")!.click();
  await waitForSolid(() => expect(values(field).length).toBeGreaterThan(0));
};

it("shows, filters and extends the effective fallback chain for the selected agent", async () => {
  const { field, onModelFallbacksChange } = renderFallbacks();
  expect(values(field, ".multi-select__chip")).toEqual([existingFallback]);
  await open(field);
  expect(values(field)).toEqual([nextFallback]);
  field.querySelector<HTMLElement>(".multi-select__option")!.click();
  expect(onModelFallbacksChange).toHaveBeenCalledWith("beta", [existingFallback, nextFallback]);
  typeSearch(field, "fixture/custom-fallback");
  expect(field.querySelector("[data-custom]")?.getAttribute("data-value")).toBe(
    "fixture/custom-fallback",
  );
});

it("disables the field without config write access", () => {
  const { input } = renderFallbacks(false);
  expect(input).toMatchObject({ disabled: true });
});
