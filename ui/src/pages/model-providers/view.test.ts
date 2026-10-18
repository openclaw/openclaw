/* @vitest-environment jsdom */

import { beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { choosePickerValue, openPicker, updatePickers } from "../../test-helpers/select-picker.ts";
import { card, mount, props, text } from "./view.test-support.tsx";
import type { ModelProvidersViewProps } from "./view.tsx";

function render(overrides: Partial<ModelProvidersViewProps> = {}, container?: HTMLElement) {
  return mount(props(overrides), container);
}
type QueryRoot = ParentNode | null | undefined;
function find<T extends Element = HTMLElement>(root: QueryRoot, selector: string): T | null {
  return root?.querySelector<T>(selector) ?? null;
}
function all<T extends Element = HTMLElement>(root: QueryRoot, selector: string): T[] {
  return [...(root?.querySelectorAll<T>(selector) ?? [])];
}

function modelDefaults(
  primary: string,
  utilityModel: ModelProvidersViewProps["defaultModels"]["utilityModel"] = null,
  fallbacks: string[] = [],
): ModelProvidersViewProps["defaultModels"] {
  return { primary, fallbacks, utilityModel };
}
type FormControl = HTMLInputElement | HTMLSelectElement | HTMLButtonElement;
function disabledControls(root: Element | null, selector = "select, input, button") {
  return all<FormControl>(root, selector).map((control) => control.disabled);
}
function noModels() {
  return card({
    auth: { kind: "ok" },
    profiles: [{ profileId: "openai:chatgpt", type: "oauth", status: "ok" }],
    modelCount: 0,
    availableModelCount: 0,
  });
}
function renderCard(
  details: Parameters<typeof card>[0],
  overrides: Partial<ModelProvidersViewProps> = {},
) {
  return render({ ...overrides, cards: [card(details)] });
}
type Probe = ModelProvidersViewProps["probeResults"][string];
function connectedProbe(profileId: string, label: string, latencyMs: number) {
  return { profileId, label, status: "ok" as const, latencyMs };
}
function probeResults(results: Probe["results"], overrides: Partial<Probe> = {}) {
  return { openai: { provider: "openai", status: "ok" as const, results, ...overrides } };
}
function expectText(root: Element | null, includes: string[], excludes: string[] = []) {
  for (const value of includes) {
    expect(text(root)).toContain(value);
  }
  for (const value of excludes) {
    expect(text(root)).not.toContain(value);
  }
}

const addProviderForm = {
  addProviderOpen: true,
  addProviderId: "anthropic",
  addProviderKey: "new-provider-key",
};

const defaultsSelector = ".model-providers__defaults";
const behaviorSelector = "#settings-model-behavior";
const optionSelector = '[role="option"]';
const providerSelector = '[data-provider-id="openai"]';

function behaviorRows(container: HTMLElement) {
  const behavior = find(container, behaviorSelector)!;
  return [settingsRow(behavior, "Thinking"), settingsRow(behavior, "Fast Mode")] as const;
}

function expectLockedOptions(defaults: Element) {
  expect(
    all(settingsRow(defaults, "Model"), optionSelector).every(
      (option) => option.getAttribute("aria-disabled") === "true",
    ),
  ).toBe(true);
}

it("offers only decision models, even without a chat provider, and retains an unavailable selection", async () => {
  const onDecisionChange = vi.fn();
  const viewProps = props({
    configuredModels: [],
    decisionModels: [{ provider: "typesafe", id: "jev-latest", name: "Jev", pluginId: "typesafe" }],
    defaultModels: { ...modelDefaults(""), decisionModel: "typesafe/retired" },
    onDecisionChange,
  });
  const container = mount(viewProps);
  await updatePickers(container);
  const picker = find<HTMLButtonElement>(container, "#model-providers-decision-model")!;
  expect(picker.disabled).toBe(false);
  expect(picker.textContent).toContain("typesafe/retired");
  await openPicker(picker);
  expect(all(container, '[role="option"][data-value="typesafe/jev-latest"]')).toHaveLength(1);
  await choosePickerValue(picker, "typesafe/retired");
  expect(onDecisionChange).not.toHaveBeenCalled();
  await choosePickerValue(picker, "typesafe/jev-latest");
  expect(onDecisionChange).toHaveBeenLastCalledWith("typesafe/jev-latest");
  await choosePickerValue(picker, "");
  expect(onDecisionChange).toHaveBeenLastCalledWith(null);

  mount({ ...viewProps, defaultsMutationBlockedReason: "Read only" }, container);
  await updatePickers(container);
  expect(find<HTMLButtonElement>(container, "#model-providers-decision-model")!.disabled).toBe(
    true,
  );
});

it("retains a saved unavailable model without offering it for another default setting", async () => {
  const onUtilityChange = vi.fn();
  const container = render({
    configuredModels: [
      { provider: "fixture", id: "ready", name: "Ready", available: true },
      { provider: "fixture", id: "blocked", name: "Blocked", available: false },
    ],
    defaultModels: modelDefaults("fixture/ready", "fixture/blocked", ["fixture/blocked"]),
    onUtilityChange,
  });

  await updatePickers(container);
  const blocked: Element[] = [];
  const ready: Element[] = [];
  for (const picker of all<HTMLElement>(container, "openclaw-select-picker")) {
    await openPicker(picker);
    blocked.push(...all(picker, '[role="option"][data-value="fixture/blocked"]'));
    ready.push(...all(picker, '[role="option"][data-value="fixture/ready"]'));
  }
  expect(blocked).toHaveLength(3);
  expect(blocked.every((option) => option.getAttribute("aria-disabled") === "true")).toBe(true);
  expect(ready.every((option) => option.getAttribute("aria-disabled") === "false")).toBe(true);
  const utility = find<HTMLButtonElement>(container, "#model-providers-utility-model")!;
  expect(utility.textContent).toContain("Blocked");
  await choosePickerValue(utility, "fixture/blocked");
  expect(onUtilityChange).not.toHaveBeenCalled();
  await choosePickerValue(utility, "__openclaw_automatic_utility__");
  expect(onUtilityChange).toHaveBeenCalledExactlyOnceWith(null);
});

it("shows utility chain selections and edits their fallback independently", async () => {
  const onUtilityFallbackChange = vi.fn();
  const container = render({
    configuredModels: ["Utility", "Backup", "Last"].map((name) => ({
      provider: "fixture",
      id: name.toLowerCase(),
      name,
    })),
    defaultModels: modelDefaults("fixture/chat", {
      primary: "fixture/utility",
      fallbacks: ["fixture/backup", "fixture/last"],
    }),
    onUtilityFallbackChange,
  });
  await updatePickers(container);
  expect(find(container, "#model-providers-utility-model")?.textContent).toContain("Utility");
  const row = settingsRow(container, "Utility Fallback Model");
  expect(row.textContent).toContain("1 more fallback after this one");
  const picker = find<HTMLButtonElement>(row, ".picker-select__trigger")!;
  expect(picker.textContent).toContain("Backup");
  expect(find(row, '[role="option"][data-value="fixture/utility"]')).toBeNull();
  await choosePickerValue(picker, "fixture/last");
  expect(onUtilityFallbackChange).toHaveBeenLastCalledWith("fixture/last");
});

function button(container: Element, label: string): HTMLButtonElement | undefined {
  return all<HTMLButtonElement>(container, "button").find((entry) => text(entry).includes(label));
}

function settingsRow(container: Element, label: string): HTMLElement {
  const match = all<HTMLElement>(container, ".settings-row").find(
    (candidate) =>
      text(
        find(candidate, ".model-providers__label-with-help > span:first-child") ??
          find(candidate, ".settings-row__title"),
      ) === label,
  );
  if (!match) {
    throw new Error(`Missing settings row: ${label}`);
  }
  return match;
}

function selectedSegment(group: Element) {
  return find<HTMLInputElement>(group, ".settings-segmented__input:checked")?.value;
}

function selectSegment(group: Element, value: string) {
  find<HTMLInputElement>(group, `.settings-segmented__input[value="${value}"]`)!.click();
}

it("surfaces a provider-usage failure on the provider list", () => {
  const container = render({ providerUsageFailed: true });

  expect(container.textContent).toContain(
    "Provider usage is unavailable; the last request failed. Refresh to retry.",
  );
});

beforeEach(() => i18n.setLocale("en"));

it("keeps discovery failure recovery visible while another provider is pending", () => {
  const container = render({
    catalogDiscovering: true,
    catalogDiscoveryError: "A provider failed discovery.",
  });
  expect(find(container, '.model-providers__catalog-progress[role="status"]')).not.toBeNull();
  expect(
    find(container, '.model-providers__catalog-progress[role="alert"] span')?.textContent,
  ).toBe("A provider failed discovery.");
  const retry = find<HTMLButtonElement>(
    container,
    '.model-providers__catalog-progress[role="alert"] button',
  );
  expect(retry).not.toBeNull();
  expect(retry?.disabled).toBe(false);
});

it.each(["adaptive", undefined] as const)("resets explicit model behavior %s", (thinkingLevel) => {
  const onThinkingReset = vi.fn();
  const onFastModeReset = vi.fn();
  const container = render({
    thinkingLevel,
    fastMode: thinkingLevel ? true : undefined,
    onThinkingReset,
    onFastModeReset,
  });
  const [thinkingRow, fastRow] = behaviorRows(container);

  if (thinkingLevel) {
    expect(selectedSegment(thinkingRow)).toBe("adaptive");
    expectText(thinkingRow, ["Adaptive"], ["Default: Model policy"]);
    expectText(fastRow, [], ["Default: Model policy"]);
    for (const [row, help] of [
      [thinkingRow, "model's thinking policy"],
      [fastRow, "Unlike Auto"],
    ] as const) {
      expect(find(row, 'openclaw-tooltip [slot="content"]')?.textContent).toContain(help);
      expect(find(row, ".settings-segmented__btn button")).toBeNull();
      expect(
        find(row, '.settings-segmented__input[value=""]')?.parentElement?.hasAttribute("title"),
      ).toBe(false);
    }
  }

  selectSegment(thinkingRow, "");
  selectSegment(fastRow, "");
  expect(onThinkingReset).toHaveBeenCalledOnce();
  expect(onFastModeReset).toHaveBeenCalledOnce();

  render(
    {
      thinkingLevel: undefined,
      thinkingOverridden: false,
      fastMode: undefined,
      fastModeOverridden: false,
    },
    container,
  );
  for (const row of behaviorRows(container)) {
    expect(selectedSegment(row)).toBe("");
    expect(text(row)).not.toContain("Using default: Model policy");
  }
  expect(
    all(find(container, behaviorSelector), 'button[aria-label="Reset to default"]'),
  ).toHaveLength(0);
});

it("restores controlled model behavior when a reset is rejected", () => {
  const viewProps = props({ thinkingLevel: "high", fastMode: true });
  const container = mount(viewProps);
  const [thinking, fastMode] = behaviorRows(container);

  selectSegment(thinking, "");
  selectSegment(fastMode, "");
  mount(viewProps, container);

  expect([thinking, fastMode].map(selectedSegment)).toEqual(["high", "on"]);
});

it("locks provider and default-model mutations while shared config work is pending", async () => {
  const onPrimaryChange = vi.fn();
  const container = renderCard(
    {
      hasConfigApiKey: true,
      apiKey: { source: "config" },
      profiles: [{ profileId: "openai:one", type: "oauth", status: "ok", logoutSupported: true }],
      logoutTargets: [{ provider: "openai", profileIds: ["openai:one"] }],
    },
    {
      configBusy: true,
      onPrimaryChange,
      defaultModels: modelDefaults("openai/gpt-5", null, ["anthropic/claude"]),
      configuredModels: [
        { id: "openai/gpt-5", provider: "openai", name: "GPT-5", available: true },
        { id: "anthropic/claude", provider: "anthropic", name: "Claude", available: true },
      ],
      keyEditorProvider: "openai",
      keyDraft: "replacement",
      ...addProviderForm,
    },
  );

  const defaults = find(container, defaultsSelector);
  await updatePickers(container);
  const primary = settingsRow(defaults!, "Model").querySelector<HTMLButtonElement>("button")!;
  expect(primary.disabled).toBe(false);
  await choosePickerValue(primary, "anthropic/claude");
  expect(onPrimaryChange).not.toHaveBeenCalled();
  expectLockedOptions(defaults!);
  expect(
    all<HTMLButtonElement>(defaults, ".model-providers__fallback-row button").every(
      (control) => control.disabled,
    ),
  ).toBe(true);
  expect(button(defaults!, "Save")).toBeUndefined();

  const provider = find(container, providerSelector)!;
  expect([
    find<HTMLInputElement>(provider, ".model-providers__inline-form input")?.disabled,
    button(provider, "Set API key")?.disabled,
    button(provider, "Remove key")?.disabled,
    find<HTMLButtonElement>(provider, ".model-providers__profile-logout")?.disabled,
  ]).toEqual([true, true, true, true]);

  const addForm = find(container, "[data-models-key-dialog]");
  expect(disabledControls(addForm)).toEqual([true, false, true]);
});

it("locks an already-open provider form after mutation access is revoked", async () => {
  const onAddProvider = vi.fn();
  const onAddProviderToggle = vi.fn();
  const container = render({
    ...addProviderForm,
    canMutate: false,
    mutationBlockedReason: "Operator admin access required",
    defaultsMutationBlockedReason: "Operator admin access required",
    messages: {
      defaults: { kind: "error", text: "Requires operator.admin access." },
    },
    onAddProvider,
    onAddProviderToggle,
  });
  const addForm = find(container, "[data-models-key-dialog]");
  expect(disabledControls(addForm)).toEqual([true, false, true]);
  const defaults = find(container, defaultsSelector);
  await updatePickers(container);
  const primary = settingsRow(defaults!, "Model").querySelector<HTMLButtonElement>("button")!;
  expect(primary.disabled).toBe(false);
  await openPicker(primary);
  expectLockedOptions(defaults!);
  expect(text(defaults)).not.toContain("operator.admin access");
  button(addForm!, "Save provider")?.click();
  expect(onAddProvider).not.toHaveBeenCalled();

  const cancel = button(addForm!, "Cancel");
  expect(cancel?.disabled).toBe(false);
  cancel?.click();
  expect(onAddProviderToggle).toHaveBeenCalledOnce();
});

it("freezes provider and credential fields while adding a provider", () => {
  const container = render({ ...addProviderForm, busy: { add: true } });
  const addForm = find(container, "[data-models-key-dialog]");

  expect(disabledControls(addForm, "select, input")).toEqual([true]);
});

it("keeps committed default-model success visible beside its refresh warning", () => {
  const container = render({
    messages: {
      defaults: { kind: "success", text: "Saved.", warning: "Refresh failed." },
    },
  });
  const defaults = find(container, defaultsSelector);
  const messages = all(defaults, '.callout[role="status"]');

  expect(messages.map(text)).toEqual(["Saved.", "Refresh failed."]);
  expect(messages[0]?.classList.contains("success")).toBe(true);
  expect(messages[1]?.classList.contains("warning")).toBe(true);
});

it("keeps model behavior available while provider data loads", () => {
  const container = render({ loading: true, thinkingLevel: "high", fastMode: true });
  const behavior = find(container, behaviorSelector);

  expect(behavior).not.toBeNull();
  expect(behaviorRows(container).map(selectedSegment)).toEqual(["high", "on"]);
  expect(text(container)).not.toContain("Configure a provider before selecting default models.");
  expect(find(container, '[aria-busy="true"]')).not.toBeNull();
  expect(find(container, '[data-provider-id="openai"]')).toBeNull();
});

it("renders credential provenance and per-credential request timing without aggregate timing", () => {
  const container = render({
    probeResults: probeResults(
      [
        connectedProbe("openai:default", "Default profile", 145),
        connectedProbe("openai:secondary", "Secondary profile", 320),
      ],
      { status: "ok", latencyMs: 9_145 },
    ),
  });
  const provider = find(container, '[data-provider-id="openai"]');
  expectText(provider, [
    "Credentials for Writer",
    "Global usage and cost",
    "API key from environment (OPENAI_API_KEY)",
  ]);
  expect(text(find(provider, ".model-providers__probe-summary") ?? null)).toBe("Connected");
  expect(
    all(provider, ".model-providers__probe-target").map((target) => all(target, "span").map(text)),
  ).toEqual([
    ["Default profile", "Connected · Request round-trip: 145 ms"],
    ["Secondary profile", "Connected · Request round-trip: 320 ms"],
  ]);
  expect(text(provider)).not.toContain("9145");
});

it("puts model recovery first when credentials expose no selectable models", () => {
  const onConnectProvider = vi.fn();
  const container = render({
    cards: [noModels()],
    configuredModels: [],
    defaultModels: modelDefaults(""),
    onConnectProvider,
  });

  const readiness = find(container, '[data-model-readiness="model-required"]');
  expectText(readiness, ["Connect a verified AI model", "Model required"]);
  expect(find(container, defaultsSelector)).not.toBeNull();
  expect(text(find(container, '[data-provider-id="openai"]'))).toContain("Credentials configured");

  button(readiness!, "Connect provider")?.click();
  expect(onConnectProvider).toHaveBeenCalledOnce();

  render({}, container);
  expect(find(container, '[data-model-readiness="ready"]')).toBe(readiness);
  expectText(readiness, ["AI models available"], ["Model required"]);
});

it("does not present catalog-rejected credentials as signed in", () => {
  const container = renderCard(
    {
      ...noModels(),
      hasConfigApiKey: true,
      catalogStatus: "auth-rejected",
    },
    {
      configuredModels: [],
      defaultModels: modelDefaults(""),
    },
  );
  expectText(
    find(container, '[data-provider-id="openai"]'),
    ["Credentials rejected"],
    ["Signed in"],
  );
  expect(text(find(container, ".model-providers__profile-status"))).toContain(
    "Credentials configured",
  );
});

it("labels provider usage and session cost as global", () => {
  const container = renderCard({
    localCost: { totalCost: 12, totalTokens: 1_000, messageCount: 2 },
  });

  const provider = find(container, '[data-provider-id="openai"]');
  expectText(provider, [
    "Credentials for Writer",
    "Global usage and cost",
    "Global session spend · 30d",
  ]);
});

it("does not invent config key provenance when auth status is unavailable", () => {
  const container = renderCard({ apiKey: undefined, hasConfigApiKey: true });

  const provider = find(container, '[data-provider-id="openai"]');
  expectText(provider, ["Not configured"], ["API key set in config"]);
});

it("renders mixed credential probes as connected with warnings", () => {
  const container = render({
    probeResults: probeResults(
      [
        {
          label: "Configured credential · openai/gpt-5.6-sol",
          status: "unknown",
          error: "Update or remove it, then retry.",
        },
        connectedProbe("openai:default", "Profile Default · openai/gpt-5.6-sol", 145),
      ],
      { status: "ok", latencyMs: 145 },
    ),
  });

  const probe = find(container, ".model-providers__probe--warning");
  expectText(probe, [
    "Connected with warnings",
    "Configured credential · openai/gpt-5.6-sol",
    "Profile Default · openai/gpt-5.6-sol",
    "Update or remove it, then retry",
  ]);
  const targets = all(probe, ".model-providers__probe-target");
  expect(text(targets?.[0] ?? null)).not.toContain("Request round-trip");
  expect(text(targets?.[1] ?? null)).toContain("Request round-trip: 145 ms");
});

it("presents no-model probe results as a setup state, not a connection failure", () => {
  const container = render({
    cards: [noModels()],
    configuredModels: [],
    probeResults: probeResults(
      [
        {
          profileId: "openai:chatgpt",
          label: "ChatGPT",
          status: "no_model",
        },
      ],
      { status: "no_model", error: "No model is available for this provider." },
    ),
  });

  const provider = find(container, '[data-provider-id="openai"]');
  expectText(provider, ["Credentials configured", "No models available"], ["Connection failed"]);
});

it("renders alias defaults and distinct automatic or disabled utility states", async () => {
  const aliasEntry = { ...utilityModels[0]!, selectionRef: "opus" };
  const automatic = render({
    configuredModels: [aliasEntry],
    defaultModels: modelDefaults("opus"),
    automaticUtilityModel: null,
  });
  await updatePickers(automatic);
  await openPicker(find(automatic, "openclaw-select-picker")!);
  expect(find(automatic, '[data-value="opus"]')?.getAttribute("aria-selected")).toBe("true");
  expect(await utilityOption(automatic)).toEqual({
    label: "Auto",
    detail: "No recommended small model",
  });

  const disabled = render({
    configuredModels: [aliasEntry],
    defaultModels: modelDefaults("opus", ""),
  });
  await updatePickers(disabled);
  await openPicker(utilityPicker(disabled));
  expect(text(find(utilityPicker(disabled), '[role="option"][aria-selected="true"]'))).toBe(
    "Disabled",
  );
});

function utilityPicker(container: HTMLElement) {
  return all(container, ".model-providers__defaults openclaw-select-picker")[1]!;
}

async function utilityOption(container: HTMLElement, value?: string) {
  await openPicker(utilityPicker(container));
  const option = find(
    utilityPicker(container),
    value === undefined
      ? '[role="option"][aria-selected="true"]'
      : `[role="option"][data-value="${value}"]`,
  );
  return {
    label: text(find(option, ".picker-select__label") ?? null),
    detail: text(find(option, ".picker-select__description") ?? null),
  };
}
const utilityModels = [
  { id: "claude-opus", provider: "anthropic", name: "Claude Opus", available: true },
  { id: "claude-haiku-4-5", provider: "anthropic", name: "Claude Haiku 4.5", available: true },
];

it("shows the route on an explicitly chosen utility model, not on Auto", async () => {
  const container = render({
    configuredModels: utilityModels,
    defaultModels: modelDefaults("anthropic/claude-opus", "anthropic/claude-haiku-4-5"),
    automaticUtilityModel: "anthropic/claude-haiku-4-5",
    utilityRuntime: { id: "claude-cli", kind: "cli", label: "Claude CLI" },
  });
  await updatePickers(container);
  const chosen = await utilityOption(container, "anthropic/claude-haiku-4-5");
  expect(chosen.label).toBe("Claude Haiku 4.5");
  expect(chosen.detail).toContain("Claude CLI · native");
  expect((await utilityOption(container, "__openclaw_automatic_utility__")).detail).not.toContain(
    "Claude CLI",
  );
});

it("disables probing when the gateway does not advertise the method", () => {
  const onProbe = vi.fn();
  const container = render({ probeAvailable: false, onProbe });
  const testButton = button(container, "Test connection");
  expect(testButton?.disabled).toBe(true);
  expect(testButton?.title).toContain("newer gateway");
  testButton?.click();
  expect(onProbe).not.toHaveBeenCalled();
});

it("uses every credential owner id for connection probes", () => {
  const onProbe = vi.fn();
  const container = renderCard({ credentialProviderIds: ["anthropic", "claude-cli"] }, { onProbe });
  button(container, "Test connection")?.click();
  expect(onProbe).toHaveBeenCalledWith("openai", ["anthropic", "claude-cli"]);
});

it("keeps the key editor focused while typing and uses the original config key for mutations", () => {
  const onSaveKey = vi.fn();
  const onRemoveKey = vi.fn();
  let viewProps = props({
    cards: [card({ configKey: "OpenAI", apiKey: { source: "config" }, hasConfigApiKey: true })],
    keyEditorProvider: "openai",
    keyDraft: "replacement",
    onSaveKey,
    onRemoveKey,
    onKeyDraftChange: (value) => {
      viewProps = {
        ...viewProps,
        keyDraft: value,
        cards: viewProps.cards.map((entry) => ({ ...entry })),
      };
      mount(viewProps, container);
    },
  });
  const container = mount(viewProps);
  const provider = find(container, '[data-provider-id="openai"]');
  expect(provider).not.toBeNull();
  const input = provider!.querySelector<HTMLInputElement>(".model-providers__inline-form input")!;
  input.focus();
  for (const value of ["replacement-1", "replacement-12"]) {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(find(container, ".model-providers__inline-form input")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe(value);
  }
  button(provider!, "Save")?.click();
  button(provider!, "Remove key")?.click();
  expect(onSaveKey).toHaveBeenCalledWith("openai", "OpenAI");
  expect(onRemoveKey).toHaveBeenCalledWith("openai", "OpenAI");
});

it("shows the current key-operation failure over an older card success", () => {
  const container = render({
    messages: {
      openai: { kind: "success", text: "Older success" },
      "key:openai": { kind: "error", text: "Current failure" },
    },
  });
  expect(text(find(container, '[data-provider-id="openai"] .callout'))).toBe("Current failure");
});

it("disables API-key mutations for explicit non-API-key auth modes", () => {
  const container = renderCard({ configAuthMode: "oauth" });
  const setKey = button(container, "Set API key");
  expect(setKey?.disabled).toBe(true);
  expect(setKey?.title).toContain('auth mode is "oauth"');
});
it("filters provider access without hiding global defaults and exposes an empty result", () => {
  const onProviderQueryChange = vi.fn();
  const viewProps = props({
    cards: [
      card(),
      card({ id: "anthropic", displayName: "Anthropic", credentialProviderIds: ["anthropic"] }),
    ],
    providerQuery: " ANTHROPIC ",
    onProviderQueryChange,
  });
  const container = mount(viewProps);
  expect(all(container, "[data-provider-id]")).toHaveLength(1);
  expect(find(container, '[data-provider-id="anthropic"]')).not.toBeNull();
  expect(find(container, behaviorSelector)).not.toBeNull();
  const search = find<HTMLInputElement>(container, 'input[type="search"]')!;
  document.body.append(container);
  search.focus();
  search.value = "missing";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  expect(onProviderQueryChange).toHaveBeenCalledExactlyOnceWith("missing");
  mount({ ...viewProps, providerQuery: "missing" }, container);
  expect(find(container, 'input[type="search"]')).toBe(search);
  expect(document.activeElement).toBe(search);
  expect(text(container)).toContain("No providers match your search.");
  expect(all(container, "[data-provider-id]")).toHaveLength(0);
  expect(find(container, behaviorSelector)).not.toBeNull();
});
