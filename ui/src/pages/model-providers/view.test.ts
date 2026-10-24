/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { choosePickerValue, openPicker, updatePickers } from "../../test-helpers/select-picker.ts";
import { resolveDefaultModelPresentation } from "./data.ts";
import {
  expectAbsent,
  expectPresent,
  click,
  model as catalogModel,
  expectDisabled,
  profile as authProfile,
  expectContent,
} from "./model-providers.test-fixtures.ts";
import { card, mount, props, settingsRow, text } from "./view.test-support.tsx";

function render(overrides: Parameters<typeof props>[0] = {}) {
  return mount(props(overrides));
}

function expand(container: Element, providerId = "openai"): Element {
  click(container, `[data-provider-id="${providerId}"] .provider-row__summary`);
  flush();
  return container;
}

function button(container: Element, label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
    text(entry).includes(label),
  );
}

function selectedSegment(group: Element) {
  return group.querySelector<HTMLInputElement>(".settings-segmented__input:checked")?.value;
}

function selectSegment(group: Element, value: string) {
  click(group, `.settings-segmented__input[value="${value}"]`);
}

const noModels = {
  cards: [
    card({
      auth: { kind: "ok" },
      profiles: [authProfile("openai:chatgpt")],
      modelCount: 0,
      availableModelCount: 0,
    }),
  ],
  configuredModels: [],
} satisfies Parameters<typeof props>[0];

describe("renderModelProviders", () => {
  it("does not offer one account's Ultrafast entitlement for another saved account pin", () => {
    const onFastModeChange = vi.fn();
    const configured = {
      primary: "openai/gpt-5@openai:account-b",
      fallbacks: [],
      utilityModel: null,
      thinkingLevel: "max",
      thinkingOverridden: true,
      fastMode: "ultrafast" as const,
      fastModeOverridden: true,
    };
    const forAccount = (serviceTiers: string[]) =>
      resolveDefaultModelPresentation(
        {
          hasSnapshot: true,
          retired: false,
          models: [
            {
              ...catalogModel("gpt-5", "GPT-5"),
              supportsFastMode: true,
              serviceTiers,
            },
          ],
        },
        configured,
        null,
      );
    const accountA = forAccount(["priority", "ultrafast"]);
    const viewProps = props({
      ...configured,
      defaultModels: accountA.defaults,
      configuredModels: accountA.configuredModels,
      onFastModeChange,
    });
    const container = mount(viewProps);
    const speed = settingsRow(container, "Fast Mode");
    expect(selectedSegment(speed)).toBe("ultrafast");
    expectDisabled(speed, '[value="ultrafast"]', true);
    expectAbsent(speed, '[value="on"]');
    selectSegment(speed, "ultrafast");
    expect(onFastModeChange).not.toHaveBeenCalled();
    mount({ ...viewProps, fastMode: false }, container);
    expectAbsent(speed, '[value="ultrafast"]');
    mount(
      { ...viewProps, defaultModels: { ...configured, primary: "openai/gpt-5" }, fastMode: false },
      container,
    );
    expectDisabled(speed, '[value="ultrafast"]', false);
    selectSegment(speed, "ultrafast");
    expect(onFastModeChange).toHaveBeenCalledExactlyOnceWith("ultrafast");
  });

  it("offers advertised thinking and Ultrafast without rewriting a saved preference on model changes", () => {
    const onThinkingChange = vi.fn();
    const onFastModeChange = vi.fn();
    const model = {
      ...catalogModel("gpt-5", "GPT-5"),
      thinkingLevels: [
        { id: "max", label: "Max" },
        { id: "ultra", label: "Ultra" },
        { id: "adaptive", label: "Provider effort" },
      ],
      supportsFastMode: true,
      serviceTiers: ["priority", "ultrafast"],
    };
    const viewProps = props({
      configuredModels: [model],
      thinkingLevel: "max",
      fastMode: "ultrafast",
      onThinkingChange,
      onFastModeChange,
    });
    const container = mount(viewProps);
    const thinking = settingsRow(container, "Thinking");
    const fast = settingsRow(container, "Fast Mode");
    expect(selectedSegment(fast)).toBe("ultrafast");
    expect(text(thinking)).toContain("Ultra");
    selectSegment(thinking, "adaptive");
    expect(onThinkingChange).toHaveBeenCalledWith("adaptive");
    selectSegment(fast, "on");
    expect(onFastModeChange).toHaveBeenCalledWith(true);
    selectSegment(fast, "ultrafast");
    // Reselecting a saved value must not rewrite it.
    expect(onFastModeChange).toHaveBeenCalledTimes(1);
    mount(
      {
        ...viewProps,
        defaultModels: { primary: "openai/other", fallbacks: [], utilityModel: null },
        configuredModels: [
          model,
          { ...model, id: "other", thinkingLevels: [], supportsFastMode: false, serviceTiers: [] },
        ],
      },
      container,
    );
    expect(selectedSegment(thinking)).toBe("max");
    expect(selectedSegment(fast)).toBe("ultrafast");
    expectDisabled(thinking, '[value="max"]', true);
    expectDisabled(fast, '[value="ultrafast"]', true);
    expectAbsent(thinking, '[value="adaptive"]');
    expectAbsent(fast, '[value="on"]');
    expect(onThinkingChange).toHaveBeenCalledTimes(1);
    expect(onFastModeChange).toHaveBeenCalledTimes(1);
  });

  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("shows inherited model policy, restores overrides, and preserves advanced thinking", () => {
    const onThinkingReset = vi.fn();
    const onFastModeReset = vi.fn();
    const container = render({
      thinkingLevel: "adaptive",
      fastMode: true,
      onThinkingReset,
      onFastModeReset,
    });
    const behavior = container.querySelector("#settings-model-behavior")!;
    const thinkingRow = settingsRow(behavior, "Thinking");
    const fastRow = settingsRow(behavior, "Fast Mode");

    expect(selectedSegment(thinkingRow)).toBe("adaptive");
    expect(text(thinkingRow)).toContain("Adaptive");
    expectContent(thinkingRow.querySelector('openclaw-tooltip [slot="content"]'), [
      "model's thinking policy",
    ]);
    expectContent(fastRow.querySelector('openclaw-tooltip [slot="content"]'), ["Unlike Auto"]);
    for (const row of [thinkingRow, fastRow]) {
      expectContent(row, [], ["Default: Model policy"]);
      expectAbsent(row, ".settings-segmented__btn button");
      expect(
        row
          .querySelector('.settings-segmented__input[value=""]')
          ?.parentElement?.hasAttribute("title"),
      ).toBe(false);
    }

    selectSegment(thinkingRow, "");
    selectSegment(fastRow, "");
    expect(onThinkingReset).toHaveBeenCalledOnce();
    expect(onFastModeReset).toHaveBeenCalledOnce();

    mount(
      props({
        thinkingLevel: undefined,
        thinkingOverridden: false,
        fastMode: undefined,
        fastModeOverridden: false,
      }),
      container,
    );
    const inheritedBehavior = container.querySelector("#settings-model-behavior")!;
    const inheritedThinking = settingsRow(inheritedBehavior, "Thinking");
    const inheritedFast = settingsRow(inheritedBehavior, "Fast Mode");
    expect(selectedSegment(inheritedThinking)).toBe("");
    expect(selectedSegment(inheritedFast)).toBe("");
    expectContent(inheritedThinking, [], ["Using default: Model policy"]);
    expectContent(inheritedFast, [], ["Using default: Model policy"]);
    expect(
      inheritedBehavior.querySelectorAll('button[aria-label="Reset to default"]'),
    ).toHaveLength(0);
  });

  it("keeps invalid explicit behavior values resettable", () => {
    const onThinkingReset = vi.fn();
    const onFastModeReset = vi.fn();
    const container = render({
      thinkingLevel: undefined,
      fastMode: undefined,
      thinkingOverridden: true,
      fastModeOverridden: true,
      onThinkingReset,
      onFastModeReset,
    });
    selectSegment(settingsRow(container, "Thinking"), "");
    selectSegment(settingsRow(container, "Fast Mode"), "");
    expect(onThinkingReset).toHaveBeenCalledOnce();
    expect(onFastModeReset).toHaveBeenCalledOnce();
  });

  it("restores controlled behavior after a rejected reset", () => {
    const initial = props({ thinkingLevel: "high", fastMode: true });
    const container = mount(initial);
    const rows = [settingsRow(container, "Thinking"), settingsRow(container, "Fast Mode")];
    for (const row of rows) {
      selectSegment(row, "");
    }
    mount(initial, container);
    expect(rows.map(selectedSegment)).toEqual(["high", "on"]);
  });

  it.each([
    { reason: "shared config work", configBusy: true },
    {
      reason: "revoked access",
      canMutate: false,
      defaultsMutationBlockedReason: "Operator admin access required",
    },
  ])(
    "locks provider and default mutations during $reason, but permits cancelling",
    async (blocked) => {
      const onPrimaryChange = vi.fn();
      const onAddProvider = vi.fn();
      const onAddProviderToggle = vi.fn();
      const container = render({
        ...blocked,
        onPrimaryChange,
        onAddProvider,
        onAddProviderToggle,
        defaultModels: {
          primary: "openai/gpt-5",
          fallbacks: ["anthropic/claude"],
          utilityModel: null,
        },
        configuredModels: [
          catalogModel("openai/gpt-5", "GPT-5"),
          catalogModel("anthropic/claude", "Claude", "anthropic"),
        ],
        cards: [
          card({
            configApiKeys: [{ key: "openai", reference: false }],
            apiKey: { source: "config" },
            profiles: [authProfile("openai:one", { logoutSupported: true })],
            logoutTargets: [{ provider: "openai", profileIds: ["openai:one"] }],
          }),
        ],
        keyEditorProvider: "openai",
        keyDraft: "replacement",
        addProviderOpen: true,
        addProviderId: "anthropic",
        addProviderKey: "new-provider-key",
        messages: {
          defaults: { kind: "error", text: "Configuration changes require operator.admin access." },
        },
      });
      const defaults = container.querySelector(".model-providers__defaults")!;
      await updatePickers(container);
      const primary = settingsRow(defaults, "Model").querySelector<HTMLButtonElement>("button")!;
      expect(primary.disabled).toBe(false);
      await choosePickerValue(primary, "anthropic/claude");
      expect(onPrimaryChange).not.toHaveBeenCalled();
      expect(
        [...settingsRow(defaults, "Model").querySelectorAll('[role="option"]')].every(
          (option) => option.getAttribute("aria-disabled") === "true",
        ),
      ).toBe(true);
      expect(
        [
          ...defaults.querySelectorAll<HTMLButtonElement>(".model-providers__fallback-row button"),
        ].every((control) => control.disabled),
      ).toBe(true);
      expect(button(defaults, "Save")).toBeUndefined();
      expectContent(defaults, [], ["operator.admin access"]);
      const provider = container.querySelector('[data-provider-id="openai"]')!;
      expectDisabled(provider, ".model-providers__inline-form input", true);
      expectDisabled(provider, ".model-providers__profile-logout", true);
      for (const label of ["Set API key", "Remove provider"]) {
        expect(button(provider, label)?.disabled).toBe(true);
      }
      const form = container.querySelector("[data-models-key-dialog]")!;
      expect(
        [...form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")].map(
          (control) => control.disabled,
        ),
      ).toEqual([true, false, true]);
      button(form, "Save provider")!.click();
      expect(onAddProvider).not.toHaveBeenCalled();
      button(form, "Cancel")!.click();
      expect(onAddProviderToggle).toHaveBeenCalledOnce();
    },
  );

  it("freezes provider and credential fields while adding a provider", () => {
    const container = render({
      addProviderOpen: true,
      addProviderId: "anthropic",
      addProviderKey: "new-provider-key",
      busy: { add: true },
    });
    const addForm = container.querySelector("[data-models-key-dialog]");

    expect(
      [
        ...(addForm?.querySelectorAll<HTMLInputElement | HTMLSelectElement>("select, input") ?? []),
      ].map((control) => control.disabled),
    ).toEqual([true]);
  });

  it("keeps model behavior available while provider data loads", () => {
    const container = render({ loading: true, thinkingLevel: "high", fastMode: true });
    const behavior = container.querySelector("#settings-model-behavior");

    expect(behavior).not.toBeNull();
    expect(selectedSegment(settingsRow(behavior!, "Thinking"))).toBe("high");
    expect(selectedSegment(settingsRow(behavior!, "Fast Mode"))).toBe("on");
    expect(text(container)).not.toContain("Configure a provider before selecting default models.");
    expectPresent(container, '[aria-busy="true"]');
    expectAbsent(container, '[data-provider-id="openai"]');
  });

  it.each([true])(
    "does not present catalog-rejected credentials as signed in (configured key: %s)",
    (hasConfigApiKey) => {
      const container = render({
        cards: [
          card({
            auth: { kind: "ok" },
            profiles: [authProfile("openai:chatgpt")],
            configApiKeys: hasConfigApiKey ? [{ key: "openai", reference: false }] : [],
            catalogStatus: "auth-rejected",
            modelCount: 0,
            availableModelCount: 0,
          }),
        ],
        configuredModels: [],
        defaultModels: { primary: "", fallbacks: [], utilityModel: null },
      });

      const provider = container.querySelector('[data-provider-id="openai"]');
      expect(text(provider)).toContain("Credentials rejected");
      expect(text(provider)).not.toContain("Signed in");
      expect(text(container.querySelector(".model-providers__profile-status"))).toContain(
        "Credentials configured",
      );
    },
  );

  it("collapses settled rows and keeps rows that need attention open", () => {
    const container = render({
      cards: [card(), card({ id: "anthropic", catalogStatus: "auth-rejected" })],
    });
    expectAbsent(container, "[data-model-readiness]");
    const summary = (id: string) =>
      container.querySelector<HTMLButtonElement>(
        `[data-provider-id="${id}"] .provider-row__summary`,
      )!;
    const detail = (id: string) =>
      container.querySelector(`[data-provider-id="${id}"] .provider-row__detail`);
    expect(summary("openai").getAttribute("aria-expanded")).toBe("false");
    expect(detail("openai")).toBeNull();
    expect(summary("anthropic").getAttribute("aria-expanded")).toBe("true");
    expect(detail("anthropic")).not.toBeNull();

    expand(container, "openai");
    expect(summary("openai").getAttribute("aria-expanded")).toBe("true");
    expect(detail("openai")?.id).toBe(summary("openai").getAttribute("aria-controls"));
    // A rejected credential stays visible until it is fixed.
    expand(container, "anthropic");
    expect(detail("anthropic")).not.toBeNull();
  });

  it("does not invent config key provenance when auth status is unavailable", () => {
    const container = render({
      cards: [card({ apiKey: undefined, configApiKeys: [{ key: "openai", reference: false }] })],
    });

    const provider = expand(container).querySelector('[data-provider-id="openai"]');
    expect(text(provider)).not.toContain("API key set in config");
    // Models are available, so the provider works with credentials OpenClaw does not hold.
    expect(text(provider)).toContain("Credentials managed outside OpenClaw");
  });

  it.each([
    {
      state: "ok" as const,
      style: "success",
      error: undefined,
      results: [{ label: "Default profile", status: "ok" as const, latencyMs: 145 }],
      includes: ["Credentials for Writer", "API key from environment (OPENAI_API_KEY)"],
      excludes: ["9145"],
      summary: "Connected",
      targets: [["Default profile", "Connected · Request round-trip: 145 ms"]],
    },
    {
      state: "ok" as const,
      style: "warning",
      error: undefined,
      results: [
        {
          label: "Configured credential",
          status: "unknown" as const,
          error: "Update or remove it, then retry.",
        },
        { label: "Profile Default", status: "ok" as const, latencyMs: 145 },
      ],
      includes: ["Update or remove it, then retry"],
      excludes: ["9145"],
      summary: "Connected with warnings",
      targets: [
        ["Configured credential", "Connection failed"],
        ["Profile Default", "Connected · Request round-trip: 145 ms"],
      ],
    },
    {
      state: "no_model" as const,
      style: "error",
      error: "No model is available for this provider.",
      results: [{ label: "ChatGPT", status: "no_model" as const }],
      includes: ["Credentials configured", "No model is available for this provider."],
      excludes: ["Connection failed"],
      summary: "No models available",
      targets: [["ChatGPT", "No models available"]],
    },
  ])(
    "renders $style credential probes with per-target timing",
    ({ state, style, error, results, includes, excludes, summary, targets }) => {
      const container = render({
        ...(state === "no_model" ? noModels : {}),
        probeResults: {
          openai: { provider: "openai", status: state, latencyMs: 9145, error, results },
        },
      });
      const provider = container.querySelector('[data-provider-id="openai"]')!;
      expectContent(provider, includes, excludes);
      expectPresent(provider, `.model-providers__probe--${style}`);
      expect(text(provider.querySelector(".model-providers__probe-summary"))).toBe(summary);
      expect(
        [...provider.querySelectorAll(".model-providers__probe-target")].map((target) =>
          [...target.querySelectorAll("span")].map(text),
        ),
      ).toEqual(targets);
    },
  );

  async function utilityOption(container: HTMLElement, value: string) {
    const picker = await openPicker(
      container.querySelector<HTMLElement>("#model-providers-utility-model")!,
    );
    const option = picker.querySelector(`[role="option"][data-value="${value}"]`);
    return {
      label: text(option?.querySelector(".picker-select__label") ?? null),
      detail: text(option?.querySelector(".picker-select__description") ?? null),
    };
  }
  const utilityModels = [
    catalogModel("claude-opus", "Claude Opus", "anthropic"),
    catalogModel("claude-haiku-4-5", "Claude Haiku 4.5", "anthropic"),
  ];

  it("shows the route on an explicitly chosen utility model, not on Auto", async () => {
    const container = render({
      configuredModels: utilityModels,
      defaultModels: {
        primary: "anthropic/claude-opus",
        fallbacks: [],
        utilityModel: "anthropic/claude-haiku-4-5",
      },
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
    const container = expand(render({ probeAvailable: false, onProbe }));
    const testButton = button(container, "Test connection");
    expect(testButton?.disabled).toBe(true);
    expect(testButton?.title).toContain("newer gateway");
    testButton?.click();
    expect(onProbe).not.toHaveBeenCalled();
  });

  it("uses every credential owner id for connection probes", () => {
    const onProbe = vi.fn();
    const container = render({
      cards: [card({ credentialProviderIds: ["anthropic", "claude-cli"] })],
      onProbe,
    });
    button(expand(container), "Test connection")!.click();
    expect(onProbe).toHaveBeenCalledWith("openai", ["anthropic", "claude-cli"]);
  });

  it("keeps the key editor focused while typing and uses the original config key for mutations", () => {
    const onSaveKey = vi.fn();
    let viewProps = props({
      cards: [
        card({
          configKey: "OpenAI",
          apiKey: { source: "config" },
          configApiKeys: [{ key: "OpenAI", reference: false }],
        }),
      ],
      keyEditorProvider: "openai",
      keyDraft: "replacement",
      onSaveKey,
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
    const provider = container.querySelector('[data-provider-id="openai"]');
    expect(provider).not.toBeNull();
    const input = provider!.querySelector<HTMLInputElement>(".model-providers__inline-form input")!;
    input.focus();
    for (const value of ["replacement-1", "replacement-12"]) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(container.querySelector(".model-providers__inline-form input")).toBe(input);
      expect(document.activeElement).toBe(input);
      expect(input.value).toBe(value);
    }
    button(provider!, "Save")?.click();
    expect(onSaveKey).toHaveBeenCalledWith("openai", "OpenAI");
  });

  it("shows the current key-operation failure over an older card success", () => {
    const container = render({
      messages: {
        openai: { kind: "success", text: "Older success" },
        "key:openai": { kind: "error", text: "Current failure" },
      },
    });
    expect(text(container.querySelector('[data-provider-id="openai"] .callout'))).toBe(
      "Current failure",
    );
  });

  it("disables API-key mutations for explicit non-API-key auth modes", () => {
    const container = render({
      cards: [card({ configAuthMode: "oauth" })],
    });
    const setKey = button(expand(container), "Set API key");
    expect(setKey?.disabled).toBe(true);
    expect(setKey?.title).toContain('auth mode is "oauth"');
  });
});

it("filters provider access without hiding global defaults and exposes an empty result", () => {
  const viewProps = props({
    cards: [
      card(),
      card({ id: "anthropic", displayName: "Anthropic", credentialProviderIds: ["anthropic"] }),
    ],
    providerQuery: " ANTHROPIC ",
  });
  const container = mount(viewProps);
  expect(container.querySelectorAll("[data-provider-id]")).toHaveLength(1);
  expectPresent(container, '[data-provider-id="anthropic"]');
  expectPresent(container, "#settings-model-behavior");
  const search = container.querySelector<HTMLInputElement>('input[type="search"]')!;
  document.body.append(container);
  search.focus();
  search.value = "missing";
  search.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
  expect(container.querySelector('input[type="search"]')).toBe(search);
  expect(document.activeElement).toBe(search);
  expect(text(container)).toContain("No providers match your search.");
  expect(container.querySelectorAll("[data-provider-id]")).toHaveLength(0);
  expectPresent(container, "#settings-model-behavior");
});

it("lists usable providers first, each group alphabetical", () => {
  const unusable = { apiKey: undefined, modelCount: 0, availableModelCount: 0 };
  const container = render({
    cards: [
      card({ id: "zeta", displayName: "Zeta", ...unusable }),
      card({ id: "xai", displayName: "xAI" }),
      card({ id: "alpha", displayName: "Alpha", ...unusable }),
      card({ id: "anthropic", displayName: "Anthropic" }),
    ],
  });
  expect(
    [...container.querySelectorAll("[data-provider-id]")].map((row) =>
      row.getAttribute("data-provider-id"),
    ),
  ).toEqual(["anthropic", "xai", "alpha", "zeta"]);
});
