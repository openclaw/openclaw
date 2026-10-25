/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { getQueriesForElement } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { expect, it, vi } from "vitest";
import { configSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigCapabilityHarness,
} from "../../lib/config/config-test-harness.ts";
import { projectRuntimeConfig } from "../../lib/reactive/domain-capabilities.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { openPicker } from "../../test-helpers/select-picker.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createCuratedSettingsEditor } from "./curated-settings-editor.ts";
import { curatedSettingsPresentation } from "./curated-settings-presentation.ts";
import { CuratedSettingsPanel } from "./curated-settings.tsx";

const presentation = curatedSettingsPresentation("memory-dreaming-settings");
const panelDefaults = {
  presentation,
  parameters: { configOwner: "memory-core" },
  messageParameters: { plugin: "memory-core" },
  support: "supported",
  disabled: false,
} satisfies Partial<Parameters<typeof CuratedSettingsPanel>[0]>;

function dreamingConfig(dreaming: Record<string, unknown> | null) {
  return {
    agents: { defaults: { userTimezone: "Asia/Singapore" } },
    plugins: { entries: { "memory-core": { config: { dreaming } } } },
  };
}

function persistedConfig(dreaming: Record<string, unknown>, userTimezone = "Asia/Singapore") {
  const config = dreamingConfig(dreaming);
  return {
    ...config,
    agents: { defaults: { userTimezone } },
    channels: { slack: { botToken: { source: "env", provider: "default", id: "BOT_TOKEN" } } },
    plugins: { ...config.plugins, slots: { memory: "none" } },
  };
}

function renderInto(
  dreaming: Record<string, unknown> | null,
  onPatch: (path: readonly string[], value: unknown) => void = vi.fn(),
  disabled = false,
): HTMLElement {
  const { container } = mountSolid(() => (
    <CuratedSettingsPanel
      {...panelDefaults}
      config={dreamingConfig(dreaming)}
      disabled={disabled}
      onPatch={(_, path, value) => onPatch(path, value)}
    />
  ));
  flush();
  return container;
}

const numberInput = (container: HTMLElement, label: string) =>
  getQueriesForElement(container).getAllByLabelText<HTMLInputElement>(label)[0]!;

function editNumber(input: HTMLInputElement, value: string, bubbles = false) {
  input.value = value;
  input.dispatchEvent(new Event("change", { bubbles }));
}

const rowFor = (container: HTMLElement, title: string) =>
  expectDefined(
    getQueriesForElement(container)
      .getAllByText(title, { selector: ".settings-row__title" })[0]!
      .closest<HTMLElement>(".settings-row"),
    `Missing settings row: ${title}`,
  );

const selectedSegment = (container: HTMLElement) =>
  container.querySelector<HTMLInputElement>(".settings-segmented__input:checked")?.value ?? null;

it("defaults phases on unless explicitly disabled", () => {
  const container = renderInto({ enabled: true, phases: { deep: { enabled: false } } });
  const queries = getQueriesForElement(container);
  const checked = (title: string) =>
    queries
      .getByText(title, { selector: ".settings-section__heading" })
      .closest(".settings-section")
      ?.querySelector<HTMLInputElement>(".settings-toggle__input")?.checked;
  expect(["Light phase", "Deep phase", "REM phase"].map(checked)).toEqual([true, false, true]);
});

it("renders the runtime storage-mode default when the config omits it", () => {
  const defaultPanel = renderInto({ enabled: true });
  expect(selectedSegment(defaultPanel)).toBe("separate");
  expect(rowFor(defaultPanel, "Storage mode").textContent).not.toContain("Default:");
  const inline = renderInto({ storage: { mode: "inline" } });
  expect(rowFor(inline, "Storage mode").textContent).toContain("Default: Separate");
  expect(selectedSegment(inline)).toBe("inline");
  expect(selectedSegment(renderInto({ storage: { mode: "both" } }))).toBe("both");
  expect(selectedSegment(renderInto({ storage: { mode: "nonsense" } }))).toBe("separate");
});

it("shows the advanced execution model as the inherited model default", async () => {
  const onPatch = vi.fn();
  const execution = { defaults: { model: "openai/gpt-5.6" } };
  const container = renderInto({ model: "anthropic/claude-sonnet", execution }, onPatch);
  const row = rowFor(container, "Dreaming model");
  await openPicker(row.querySelector("openclaw-select-picker")!);

  expect(row.textContent).toContain("Default: openai/gpt-5.6");
  expect(row.querySelector('[role="option"][data-value="anthropic/claude-sonnet"]')).not.toBeNull();
  const custom = expectDefined(
    row.querySelector<HTMLInputElement>(".model-picker__custom"),
    "Missing custom model input",
  );
  expect(custom.hidden).toBe(false);
  editNumber(custom, "vendor/model with spaces", true);
  expect(onPatch).toHaveBeenCalledWith(["model"], "vendor/model with spaces");
  editNumber(custom, "", true);
  expect(onPatch).toHaveBeenCalledWith(["model"], undefined);

  const inherited = renderInto({ execution });
  const inheritedRow = rowFor(inherited, "Dreaming model");
  expect(inheritedRow.textContent).not.toContain("Using default:");
  await openPicker(inheritedRow.querySelector("openclaw-select-picker")!);
  expect(inheritedRow.querySelector("[data-provider-icon=codex]")).not.toBeNull();
});

it("locks every global dreaming control when config mutation is unavailable", () => {
  const container = renderInto(null, vi.fn(), true);

  expect(
    [...container.querySelectorAll<HTMLInputElement>("input")].every((input) =>
      input.matches(":disabled"),
    ),
  ).toBe(true);
});

it("preserves uncommitted numeric and text drafts across unrelated config refreshes", () => {
  const onPatch = vi.fn();
  const [config, setConfig] = createSignal(
    dreamingConfig({
      frequency: "0 3 * * *",
      phases: { light: { lookbackDays: 7 } },
    }),
  );
  const view = mountSolid(() => (
    <CuratedSettingsPanel
      {...panelDefaults}
      config={config()}
      onPatch={(_, path, value) => onPatch(path, value)}
    />
  ));
  flush();
  const frequency = numberInput(view.container, "Dreaming frequency");
  const lookback = numberInput(view.container, "Lookback days");
  frequency.value = "0 4 * * *";
  lookback.value = "14";
  setConfig(
    dreamingConfig({
      frequency: "0 3 * * *",
      verboseLogging: true,
      phases: { light: { lookbackDays: 7 } },
    }),
  );
  flush();
  expect(numberInput(view.container, "Dreaming frequency")).toBe(frequency);
  expect(frequency.value).toBe("0 4 * * *");
  expect(lookback.value).toBe("14");
  expect(onPatch).not.toHaveBeenCalled();
  frequency.dispatchEvent(new Event("change", { bubbles: true }));
  lookback.dispatchEvent(new Event("change", { bubbles: true }));
  expect(onPatch).toHaveBeenNthCalledWith(1, ["frequency"], "0 4 * * *");
  expect(onPatch).toHaveBeenNthCalledWith(2, ["phases", "light", "lookbackDays"], 14);
  setConfig(
    dreamingConfig({
      frequency: "0 5 * * *",
      phases: { light: { lookbackDays: 21 } },
    }),
  );
  flush();
  expect(frequency.value).toBe("0 5 * * *");
  expect(lookback.value).toBe("21");
});
it("rejects invalid numbers, accepts valid edits, and clears emptied values", () => {
  const onPatch = vi.fn();
  const container = renderInto({ enabled: true, phases: { light: { lookbackDays: 7 } } }, onPatch);

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
  editNumber(numberInput(container, "Lookback days"), "");
  expect(onPatch).toHaveBeenNthCalledWith(3, ["phases", "light", "lookbackDays"], undefined);
});

it("submits edited values and removals through the shared config owner without materializing display defaults", async () => {
  vi.useFakeTimers();
  let config: Record<string, unknown> = persistedConfig({
    frequency: "0 1 * * *",
    verboseLogging: true,
  });
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      return configSnapshot(config, "current", JSON.stringify(config));
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
        {...panelDefaults}
        config={currentConfigObject(runtime.read().state)}
        support="unknown"
        onPatch={edit}
      />
    );
  });
  try {
    flush();
    expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(0);
    editNumber(numberInput(view.container, "Limit"), "0");
    const toggle = expectDefined(
      rowFor(view.container, "Verbose logging").querySelector<HTMLInputElement>(
        ".settings-toggle__input",
      ),
      "Missing verbose logging toggle",
    );
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change", { bubbles: true }));
    const frequency = numberInput(view.container, "Dreaming frequency");
    editNumber(frequency, "");
    flush();
    expect(numberInput(view.container, "Dreaming frequency")).toBe(frequency);
    expect(frequency.value).toBe("");
    runtimeConfig.patchForm(["agents", "defaults", "userTimezone"], "Etc/UTC");
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    await runtimeConfig.waitForPendingWrites();
    expect(config).toEqual(
      persistedConfig({ verboseLogging: false, phases: { light: { limit: 0 } } }, "Etc/UTC"),
    );
  } finally {
    view.unmount();
    runtimeConfig.dispose();
    vi.useRealTimers();
  }
});
