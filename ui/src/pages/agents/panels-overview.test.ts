import { afterEach, assert, expect, it, vi } from "vitest";
import { buildAgentContext } from "../../lib/agents/display.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { Agents, type AgentsProps } from "./view.tsx";

afterEach(() => document.body.replaceChildren());

const inheritedAgentModel = "openai/gpt-5.4";
const resolvedAgentWorkspace = "/tmp/agents/beta";
const agentConfig = (defaults: Record<string, unknown>, beta: Record<string, unknown> = {}) => ({
  agents: { defaults, entries: { beta } },
});
const contextConfig = (model: Record<string, unknown>) =>
  agentConfig(
    {
      workspace: "/tmp/agents",
      model: { primary: inheritedAgentModel, fallbacks: ["openai/global-fallback"] },
    },
    { model },
  );
type AgentList = NonNullable<AgentsProps["agentsList"]>;
const roster = (beta: AgentList["agents"][number]): AgentList => ({
  defaultId: "alpha",
  mainKey: "main",
  scope: "per-sender",
  agents: [{ id: "alpha", name: "Alpha" }, beta],
});
const contextValue = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll("dt"))
    .find((term) => term.textContent?.trim() === label)
    ?.nextElementSibling?.textContent?.trim();

type ViewOverrides = Omit<Partial<AgentsProps>, "access" | "overview"> & {
  access?: Partial<AgentsProps["access"]>;
  overview?: Partial<AgentsProps["overview"]>;
  configForm?: Record<string, unknown>;
};
function renderAgents({ configForm, ...overrides }: ViewOverrides = {}, attached = false) {
  const container = document.createElement("div");
  if (attached) {
    document.body.append(container);
  }
  const defaults = createProps();
  const props = {
    ...defaults,
    ...overrides,
    config: overrides.config ?? { ...defaults.config, configForm: configForm ?? null },
    access: { ...defaults.access, ...overrides.access },
    overview: { ...defaults.overview, ...overrides.overview },
  };
  mountSolid(Agents, props, container);
  return container;
}

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
    contextConfig(model),
    null,
    "alpha",
  );

  expect(context).toMatchObject({ workspace: resolvedAgentWorkspace, model: expectedModel });
});

it.each(["overview", "channels", "cron"] as const)(
  "shows authoritative agent workspace and effective model on the %s panel",
  (activePanel) => {
    const container = renderAgents({
      activePanel,
      agentsList: roster({
        id: "beta",
        workspace: resolvedAgentWorkspace,
        model: { primary: inheritedAgentModel },
      }),
      configForm: contextConfig({ fallbacks: ["google/gemini-3-pro"] }),
    });
    expect(contextValue(container, "Workspace")).toBe(resolvedAgentWorkspace);
    expect(contextValue(container, "Primary Model")).toBe(`${inheritedAgentModel} (+1 fallback)`);
  },
);

it.each([
  { label: "a read-only editor", canUpdateIdentity: false, identitySaving: false },
  { label: "an active identity save", canUpdateIdentity: true, identitySaving: true },
])(
  "keeps identity field permissions correct for $label",
  ({ canUpdateIdentity, identitySaving }) => {
    const container = renderAgents({
      access: { canUpdateIdentity },
      overview: { identitySaving },
    });

    expect(
      container.querySelector<HTMLInputElement>(".agent-identity-editor__fields input")?.disabled,
    ).toBe(!canUpdateIdentity);
  },
);

it("shows inherited skills in the Agent Context overview", () => {
  const container = renderAgents({
    configForm: agentConfig({ skills: ["github", "weather"] }),
  });
  expect(contextValue(container, "Skills Filter")).toBe("2 selected");
});

const primary = "openai/gpt-5.4";
const existingFallback = "anthropic/claude-sonnet-4-6";
const catalog = [
  { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
  { id: "gemini-3-pro", name: "Gemini 3 Pro", provider: "google" },
] satisfies ReturnType<typeof createProps>["overview"]["modelCatalog"];

function renderFallbacks(overrides: ViewOverrides = {}) {
  const onModelFallbacksChange = vi.fn();
  const container = renderAgents(
    {
      configForm: agentConfig({ model: { primary, fallbacks: [existingFallback] } }),
      ...overrides,
      overview: {
        modelCatalog: catalog,
        ...overrides.overview,
        onModelFallbacksChange,
      },
    },
    true,
  );
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

it("shows the effective chain and excludes the primary and selected models from choices", async () => {
  const { field, input } = renderFallbacks();
  expect(values(field, ".multi-select__chip")).toEqual([existingFallback]);
  expect(input).toMatchObject({ disabled: false });
  await open(field);
  expect(values(field)).toEqual(["google/gemini-3-pro"]);
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
  const target = "custom/model-a";
  const caseDistinct = "custom/Model-A";
  const { field } = renderFallbacks({
    agentsList: roster({ id: "beta", model: { primary: caseDistinct } }),
    configForm: agentConfig({
      model: { primary: "fast@work" },
      models: { [target]: { alias: "fast" } },
    }),
    overview: {
      modelCatalog: [
        { provider: "custom", id: "model-a", name: "Lowercase model" },
        { provider: "custom", id: "Model-A", name: "Uppercase model" },
      ],
    },
  });

  await open(field);
  expect(values(field)).toEqual([caseDistinct]);
  expect(field.querySelector(".multi-select__option")?.textContent).toContain("Uppercase model");
  typeSearch(field, "FAST");
  expect(values(field)).toEqual([]);
  typeSearch(field, `${target}@other`);
  expect(values(field)).toEqual([`${target}@other`]);
});

it("disables the field without config write access", () => {
  const { input } = renderFallbacks({ access: { canUpdateConfig: false } });
  expect(input).toMatchObject({ disabled: true });
});
