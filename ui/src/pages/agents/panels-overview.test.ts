import { afterEach, assert, expect, it, vi } from "vitest";
import { choosePickerValue, updatePickers } from "../../test-helpers/select-picker.ts";
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
const overviewRow = (container: HTMLElement, label: string) =>
  Array.from(container.querySelectorAll<HTMLElement>(".settings-row")).find(
    (row) => row.querySelector(".settings-row__title")?.textContent?.trim() === label,
  );

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
      expect(contextValue(container, "Primary model")).toBe(expectedModel);
      expect(contextValue(container, "Skills filter")).toBe("2 selected");
    });
  },
);

function renderOverview(agent: Record<string, unknown> = {}) {
  const onSelectPanel = vi.fn();
  const container = renderAgents({
    configForm: contextConfig({ fallbacks: [nextFallback] }),
    onSelectPanel,
    readData: () => ({
      ...data,
      agentsPanel: "overview",
      agentsList: {
        ...data.agentsList!,
        agents: [{ id: "beta", workspace: resolvedAgentWorkspace, ...agent }],
      },
    }),
  });
  return { container, onSelectPanel };
}

it("shows Overview context as rows that open their owning tabs", async () => {
  const { container, onSelectPanel } = renderOverview();
  await waitForSolid(() =>
    expect(container.querySelector(".agent-overview__workspace")?.textContent).toBe(
      resolvedAgentWorkspace,
    ),
  );
  expect(container.querySelector(".settings-kv")).toBeNull();
  const primaryModel = overviewRow(container, "Primary model");
  assert(primaryModel);
  expect(primaryModel.querySelector(".model-picker")).not.toBeNull();
  expect(primaryModel.querySelector(".settings-row__value")).toBeNull();
  const skills = overviewRow(container, "Skills filter");
  expect(skills?.querySelector(".settings-row__value")?.textContent).toBe("2 selected");
  skills?.click();
  expect(onSelectPanel).toHaveBeenLastCalledWith("skills");
  overviewRow(container, "Workspace")?.click();
  expect(onSelectPanel).toHaveBeenLastCalledWith("files");
});

it("leaves out facts and settings the agent does not have", () => {
  const { container } = renderOverview();
  expect(overviewRow(container, "Thinking default")).toBeUndefined();
  expect(overviewRow(container, "Runtime")).toBeUndefined();
});

it("shows the runtime the agent has", () => {
  const { container } = renderOverview({ agentRuntime: { id: "codex", fallback: "pi" } });
  expect(
    overviewRow(container, "Runtime")?.querySelector(".settings-row__value")?.textContent,
  ).toBe("codex (fallback pi)");
});

const thinkingLevels = [
  { id: "off", label: "off" },
  { id: "low", label: "low" },
  { id: "high", label: "high" },
  { id: "xhigh", label: "xhigh" },
];

it("edits the agent's thinking default from the levels its model accepts", () => {
  const onThinkingDefaultChange = vi.fn();
  // The Gateway's resolved level wins over agents.defaults (per-model params, clamping).
  const container = renderAgents({
    configForm: agentConfig({ thinkingDefault: "low" }),
    overview: { onThinkingDefaultChange },
    readData: () => ({
      ...data,
      agentsPanel: "overview",
      agentsList: {
        ...data.agentsList!,
        agents: [{ id: "beta", thinkingLevels, thinkingDefault: "xhigh" }],
      },
    }),
  });
  const select = overviewRow(container, "Thinking default")?.querySelector("select");
  assert(select);
  expect(select.disabled).toBe(false);
  expect(Array.from(select.options, (option) => option.textContent)).toEqual([
    "Inherit default (Extra high)",
    "Off",
    "Low",
    "High",
    "Extra high",
  ]);
  expect(select.value).toBe("");
  select.value = "high";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  expect(onThinkingDefaultChange).toHaveBeenLastCalledWith("beta", "high");
  select.value = "";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  expect(onThinkingDefaultChange).toHaveBeenLastCalledWith("beta", null);
});

it("keeps a saved thinking default the model no longer offers", () => {
  const container = renderAgents({
    configForm: agentConfig({ thinkingDefault: "low" }, { thinkingDefault: "max" }),
    readData: () => ({
      ...data,
      agentsPanel: "overview",
      agentsList: {
        ...data.agentsList!,
        agents: [
          { id: "beta", thinkingLevels, thinkingDefault: "max", thinkingInheritedDefault: "low" },
        ],
      },
    }),
  });
  const select = overviewRow(container, "Thinking default")?.querySelector("select");
  assert(select);
  expect(select.value).toBe("max");
  expect(select.options[0]?.textContent).toBe("Inherit default (Low)");
  expect(select.selectedOptions[0]).toMatchObject({ textContent: "Maximum", disabled: true });
});

it("names the level clearing an override resolves to, not the global default", () => {
  // Global Low, a per-model param of High, and an agent override of Medium: the Gateway
  // resolves the cleared agent to High, so the inherit option must say High.
  const container = renderAgents({
    configForm: agentConfig({ thinkingDefault: "low" }, { thinkingDefault: "medium" }),
    readData: () => ({
      ...data,
      agentsPanel: "overview",
      agentsList: {
        ...data.agentsList!,
        agents: [
          {
            id: "beta",
            thinkingLevels,
            thinkingDefault: "medium",
            thinkingInheritedDefault: "high",
          },
        ],
      },
    }),
  });
  const select = overviewRow(container, "Thinking default")?.querySelector("select");
  assert(select);
  expect(select.value).toBe("medium");
  expect(select.options[0]?.textContent).toBe("Inherit default (High)");
});

it("edits the thinking default while the model catalog restricts model choices", () => {
  const container = renderAgents({
    configForm: agentConfig({}, { thinkingDefault: "high" }),
    overview: { modelSelectionPolicy: { restricted: true, defaultModel: inheritedAgentModel } },
    readData: () => ({
      ...data,
      agentsPanel: "overview",
      agentsList: {
        ...data.agentsList!,
        agents: [{ id: "beta", thinkingLevels, thinkingDefault: "high" }],
      },
    }),
  });
  const select = overviewRow(container, "Thinking default")?.querySelector("select");
  assert(select);
  expect(select.value).toBe("high");
  expect(select.disabled).toBe(false);
});

it("names no inherited level when a restricted roster omits it", () => {
  // A model-restricted roster drops thinkingInheritedDefault and its thinkingDefault is the
  // agent's own override (Medium); clearing may resolve elsewhere, so no level is claimed.
  const container = renderAgents({
    configForm: agentConfig({ thinkingDefault: "low" }, { thinkingDefault: "medium" }),
    overview: { modelSelectionPolicy: { restricted: true, defaultModel: inheritedAgentModel } },
    readData: () => ({
      ...data,
      agentsPanel: "overview",
      agentsList: {
        ...data.agentsList!,
        agents: [{ id: "beta", thinkingLevels, thinkingDefault: "medium" }],
      },
    }),
  });
  const select = overviewRow(container, "Thinking default")?.querySelector("select");
  assert(select);
  expect(select.value).toBe("medium");
  expect(select.options[0]?.textContent).toBe("Inherit default");
});

it("shows the resolved thinking level, disabled, until config is readable", () => {
  const container = renderAgents({
    readData: () => ({
      ...data,
      agentsPanel: "overview",
      agentsList: {
        ...data.agentsList!,
        agents: [{ id: "beta", thinkingLevels, thinkingDefault: "high" }],
      },
    }),
  });
  const select = overviewRow(container, "Thinking default")?.querySelector("select");
  assert(select);
  expect(select.disabled).toBe(true);
  expect(select.selectedOptions[0]?.textContent).toBe("High");
});

it("edits models without a Save or Reload of its own", () => {
  const defaults = createProps();
  const dirty = renderAgents({
    config: { ...defaults.config, configForm: agentConfig({}), configFormDirty: true },
  });
  const labels = [...dirty.querySelectorAll("button")].map((button) => button.textContent?.trim());
  expect(labels).not.toContain("Save");
  expect(labels).not.toContain("Reload config");
  expect(dirty.querySelector(".callout.warn")).toBeNull();
});

it("reaches Agent defaults from Overview and with no agent selected, not from other tabs", () => {
  const name = "Agent defaults";
  const row = (container: HTMLElement) => overviewRow(container, name);
  expect(row(renderOverview().container)).toBeDefined();
  expect(row(renderAgents({ selectedAgentId: null }))).toBeDefined();
  expect(
    row(renderAgents({ readData: () => ({ ...data, agentsPanel: "channels" }) })),
  ).toBeUndefined();
});

it.each([false, true])(
  "keeps identity field permissions correct with write access %s",
  (canUpdateIdentity) => {
    const container = renderAgents({
      access: { canUpdateIdentity },
      readData: () => ({ ...data, identitySaving: canUpdateIdentity }),
    });

    expect(
      container.querySelector<HTMLInputElement>(".agent-identity-editor__name")?.disabled,
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

it("keeps the full model ids in title for truncated controls", async () => {
  const primary = "fixture/a-very-long-primary-model-id-that-truncates-on-one-line";
  const fallback = "fixture/a-very-long-fallback-model-id-that-truncates-on-one-line";
  const container = renderAgents({
    configForm: agentConfig({ model: { primary, fallbacks: [fallback] } }),
  });
  await waitForSolid(() =>
    expect(
      Array.from(container.querySelectorAll(".picker-select__trigger")).map((trigger) =>
        trigger.getAttribute("title"),
      ),
    ).toContain(primary),
  );
  expect(container.querySelector(".multi-select__chip")?.getAttribute("title")).toBe(fallback);
});

it.each([
  [
    "its own utility model and fallbacks",
    { utilityModel: { primary: existingFallback, fallbacks: [nextFallback] } },
    "Claude Sonnet 4.6",
    `This agent's utility fallbacks: ${nextFallback}`,
  ],
  ["an unavailable own utility model", { utilityModel: "retired/small" }, "retired/small", null],
  ["the inherited utility model", {}, `Inherit default (${inheritedAgentModel})`, null],
] as const)("shows %s and edits the agent's override", async (_, beta, shown, fallbackNote) => {
  const onUtilityModelChange = vi.fn();
  const container = renderAgents({
    configForm: agentConfig({ utilityModel: inheritedAgentModel }, beta),
    overview: { modelCatalog: catalog, onUtilityModelChange },
  });
  await updatePickers(container);
  const picker = container.querySelector<HTMLButtonElement>("#agent-utility-model")!;
  expect(picker.textContent).toContain(shown);
  const row = picker.closest(".settings-row")!;
  expect(row.textContent?.includes("utility fallbacks")).toBe(fallbackNote !== null);
  if (fallbackNote) {
    expect(row.textContent).toContain(fallbackNote);
  }
  await choosePickerValue(picker, "");
  expect(onUtilityModelChange).toHaveBeenLastCalledWith("beta", "");
  await choosePickerValue(picker, nextFallback);
  expect(onUtilityModelChange).toHaveBeenLastCalledWith("beta", nextFallback);
});
