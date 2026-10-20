/* @vitest-environment jsdom */

import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigCapabilityHarness,
} from "../../lib/config/config-test-harness.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { updatePickers, openPicker } from "../../test-helpers/select-picker.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createCuratedSettingsEditor } from "./curated-settings-editor.ts";
import { curatedSettingsPresentation } from "./curated-settings-presentation.ts";
import { CuratedSettingsPanel } from "./curated-settings.tsx";

const presentation = curatedSettingsPresentation("memory-dreaming-settings");

function dreamingConfig(dreaming: Record<string, unknown> | null) {
  return {
    agents: { defaults: { userTimezone: "Asia/Singapore" } },
    plugins: { entries: { "memory-core": { config: { dreaming } } } },
  };
}

function renderInto(
  dreaming: Record<string, unknown> | null,
  onPatch: (path: readonly string[], value: unknown) => void = vi.fn(),
  disabled = false,
): HTMLElement {
  const { container } = mountSolid(() => (
    <CuratedSettingsPanel
      presentation={presentation}
      parameters={{ configOwner: "memory-core" }}
      messageParameters={{ plugin: "memory-core" }}
      config={dreamingConfig(dreaming)}
      support="supported"
      disabled={disabled}
      onPatch={(_, path, value) => onPatch(path, value)}
    />
  ));
  flush();
  return container;
}

function numberInput(container: HTMLElement, label: string): HTMLInputElement {
  const input = [...container.querySelectorAll<HTMLInputElement>("input.settings-input")].find(
    (candidate) => candidate.getAttribute("aria-label") === label,
  );
  if (!input) {
    throw new Error(`no input labelled ${label}`);
  }
  return input;
}

function editNumber(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event("change"));
}

function rowFor(container: HTMLElement, title: string): HTMLElement {
  const row = [...container.querySelectorAll<HTMLElement>(".settings-row")].find(
    (candidate) => candidate.querySelector(".settings-row__title")?.textContent?.trim() === title,
  );
  if (!row) {
    throw new Error(`no row titled ${title}`);
  }
  return row;
}

/** Toggle state keyed by "<section heading>/<row title>"; `checked` is a property binding. */
function toggleStates(container: HTMLElement): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  for (const row of container.querySelectorAll(".settings-row--toggle")) {
    const title = row.querySelector(".settings-row__title")?.textContent?.trim() ?? "";
    const section = row.closest(".settings-section")?.querySelector(".settings-section__heading");
    const key = `${section?.textContent?.trim() ?? ""}/${title}`;
    const toggle = row.querySelector<HTMLInputElement>(".settings-toggle__input");
    states[key] = toggle?.checked === true;
  }
  return states;
}

function selectedSegment(container: HTMLElement): string | null {
  return (
    container.querySelector<HTMLInputElement>(".settings-segmented__input:checked")?.value ?? null
  );
}

describe("plugin-owned Dreaming settings presentation", () => {
  it("defaults phases on unless explicitly disabled", () => {
    const states = toggleStates(
      renderInto({ enabled: true, phases: { deep: { enabled: false } } }),
    );

    expect(states["Light phase/Enabled"]).toBe(true);
    expect(states["Deep phase/Enabled"]).toBe(false);
    expect(states["REM phase/Enabled"]).toBe(true);
  });

  it("renders the runtime storage-mode default when the config omits it", () => {
    const defaultPanel = renderInto({ enabled: true });
    expect(selectedSegment(defaultPanel)).toBe("separate");
    expect(rowFor(defaultPanel, "Storage mode").textContent).not.toContain("Default:");
    expect(
      rowFor(renderInto({ storage: { mode: "inline" } }), "Storage mode").textContent,
    ).toContain("Default: Separate");
    expect(selectedSegment(renderInto({ storage: { mode: "inline" } }))).toBe("inline");
    expect(selectedSegment(renderInto({ storage: { mode: "both" } }))).toBe("both");
    // An unreadable stored value is not a fourth mode: it reads as the default.
    expect(selectedSegment(renderInto({ storage: { mode: "nonsense" } }))).toBe("separate");
  });

  it("shows the advanced execution model as the inherited model default", async () => {
    const onPatch = vi.fn();
    const container = renderInto(
      {
        model: "anthropic/claude-sonnet",
        execution: { defaults: { model: "openai/gpt-5.6" } },
      },
      onPatch,
    );
    await updatePickers(container);
    const row = rowFor(container, "Dreaming model");
    await openPicker(row.querySelector("openclaw-select-picker")!);

    expect(row.textContent).toContain("Default: openai/gpt-5.6");
    expect(
      row.querySelector('[role="option"][data-value="anthropic/claude-sonnet"]'),
    ).not.toBeNull();
    const custom = row.querySelector<HTMLInputElement>(".model-picker__custom");
    expect(custom?.hidden).toBe(false);
    if (custom) {
      custom.value = "vendor/model with spaces";
      custom.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(onPatch).toHaveBeenCalledWith(["model"], "vendor/model with spaces");
    if (custom) {
      custom.value = "";
      custom.dispatchEvent(new Event("change", { bubbles: true }));
    }
    expect(onPatch).toHaveBeenCalledWith(["model"], undefined);

    const inherited = renderInto({ execution: { defaults: { model: "openai/gpt-5.6" } } });
    await updatePickers(inherited);
    const inheritedRow = rowFor(inherited, "Dreaming model");
    expect(inheritedRow.textContent).not.toContain("Using default:");
    const trigger = inheritedRow.querySelector<HTMLButtonElement>(".picker-select__trigger");
    expect(trigger).not.toBeNull();
    trigger!.click();
    await updatePickers(inherited);
    expect(inheritedRow.querySelector("[data-provider-icon=codex]")).not.toBeNull();
  });

  it("locks every global dreaming control when config mutation is unavailable", () => {
    const container = renderInto(null, vi.fn(), true);

    expect(
      [...container.querySelectorAll<HTMLInputElement>("input")].every((input) => input.disabled),
    ).toBe(true);
    expect(
      [...container.querySelectorAll<HTMLInputElement>(".settings-toggle__input")].every(
        (toggle) => toggle.disabled,
      ),
    ).toBe(true);
    expect(
      [...container.querySelectorAll<HTMLInputElement>(".settings-segmented__input")].every(
        (input) => input.disabled,
      ),
    ).toBe(true);
  });
});

it("keeps the edited field mounted when the owner publishes updated config", () => {
  const [dreaming, setDreaming] = createSignal<Record<string, unknown>>({ frequency: "0 3 * * *" });
  const view = mountSolid(() => (
    <CuratedSettingsPanel
      presentation={presentation}
      parameters={{ configOwner: "memory-core" }}
      messageParameters={{ plugin: "memory-core" }}
      config={dreamingConfig(dreaming())}
      support="supported"
      disabled={false}
      onPatch={(_, _path, value) => setDreaming({ frequency: value })}
    />
  ));
  flush();
  const input = numberInput(view.container, "Dreaming frequency");
  editNumber(input, "0 4 * * *");
  flush();

  expect(numberInput(view.container, "Dreaming frequency")).toBe(input);
  expect(input.value).toBe("0 4 * * *");
});

describe("numeric field bounds", () => {
  // extensions/memory-core/openclaw.plugin.json: counts are integers with a
  // minimum, similarity/score fields are numbers in 0..1.
  it("rejects values the memory-core manifest would refuse instead of patching them", () => {
    const onPatch = vi.fn();
    const container = renderInto(
      { enabled: true, phases: { light: { lookbackDays: 7 } } },
      onPatch,
    );

    editNumber(numberInput(container, "Lookback days"), "-1");
    expect(numberInput(container, "Lookback days").value).toBe("7");
    editNumber(numberInput(container, "Limit"), "2.5");
    editNumber(numberInput(container, "Dedupe similarity"), "1.4");
    editNumber(numberInput(container, "Maximum age (days)"), "0");
    expect(onPatch).not.toHaveBeenCalled();

    editNumber(numberInput(container, "Lookback days"), "7");
    editNumber(numberInput(container, "Dedupe similarity"), "0.82");
    expect(onPatch).toHaveBeenNthCalledWith(1, ["phases", "light", "lookbackDays"], 7);
    expect(onPatch).toHaveBeenNthCalledWith(2, ["phases", "light", "dedupeSimilarity"], 0.82);
  });

  it("clears the stored value when the field is emptied", () => {
    const onPatch = vi.fn();
    const container = renderInto({ phases: { light: { lookbackDays: 7 } } }, onPatch);

    editNumber(numberInput(container, "Lookback days"), "");
    expect(onPatch).toHaveBeenCalledWith(["phases", "light", "lookbackDays"], undefined);
  });
});

it("submits edited values and removals through the shared config owner without materializing display defaults", async () => {
  vi.useFakeTimers();
  const secret = { source: "env", provider: "default", id: "BOT_TOKEN" };
  let config: Record<string, unknown> = {
    agents: { defaults: { userTimezone: "Asia/Singapore" } },
    channels: { slack: { botToken: secret } },
    plugins: {
      slots: { memory: "none" },
      entries: {
        "memory-core": { config: { dreaming: { frequency: "0 1 * * *", verboseLogging: true } } },
      },
    },
  };
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      return { config, raw: JSON.stringify(config), hash: "current", valid: true, issues: [] };
    }
    if (method === "config.set") {
      config = JSON.parse((params as { raw: string }).raw);
      return { config, hash: "saved" };
    }
    return {};
  });
  const { runtimeConfig } = createConfigCapabilityHarness(request);
  const edit = createCuratedSettingsEditor(presentation, {
    read: () => currentConfigObject(runtimeConfig.state),
    parameters: () => ({ configOwner: "memory-core" }),
    canEdit: () => runtimeConfig.state.connected,
    patch: (path, value) => runtimeConfig.patchForm(path, value),
    remove: (path) => runtimeConfig.removeFormValue(path),
  });
  await runtimeConfig.ensureLoaded();
  const view = mountSolid(() => {
    const runtime = projectRuntimeConfig(runtimeConfig);
    return (
      <CuratedSettingsPanel
        presentation={presentation}
        config={currentConfigObject(runtime.read().state)}
        parameters={{ configOwner: "memory-core" }}
        messageParameters={{ plugin: "memory-core" }}
        support="unknown"
        disabled={false}
        onPatch={edit}
      />
    );
  });
  try {
    flush();
    expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(0);
    editNumber(numberInput(view.container, "Limit"), "0");
    const toggle = rowFor(view.container, "Verbose logging").querySelector<HTMLInputElement>(
      ".settings-toggle__input",
    );
    if (!toggle) {
      throw new Error("Missing verbose logging toggle");
    }
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    editNumber(numberInput(view.container, "Dreaming frequency"), "");
    runtimeConfig.patchForm(["agents", "defaults", "userTimezone"], "Etc/UTC");
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    await runtimeConfig.waitForPendingWrites();
    expect(config).toEqual({
      agents: { defaults: { userTimezone: "Etc/UTC" } },
      channels: { slack: { botToken: secret } },
      plugins: {
        slots: { memory: "none" },
        entries: {
          "memory-core": {
            config: { dreaming: { verboseLogging: false, phases: { light: { limit: 0 } } } },
          },
        },
      },
    });
  } finally {
    view.unmount();
    runtimeConfig.dispose();
    vi.useRealTimers();
  }
});
