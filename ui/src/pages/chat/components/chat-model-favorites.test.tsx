/* @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.ts";
import { createApplicationGateway } from "../../../test-helpers/application-context-fixtures.ts";
import { installModelPickerLayout } from "../../../test-helpers/model-picker-layout.ts";
import { createSolidApplicationContextProvider } from "../../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createContext } from "../../skill-workshop/skill-workshop-page.test-support.ts";
import {
  modelOption,
  modelPickerProps,
  mountModelPicker,
} from "./chat-model-picker.test-support.tsx";

const key = "ui.modelFavorites:research";
const model = JSON.stringify(["openai/small", null]);

it("offers independent inline hearts on favorite and provider copies with distinct row identities", async () => {
  const view = await mount({ [key]: [model] }, undefined, {}, false);
  await expandProviders(view.container);
  await expandFavorites(view.container);
  expect(view.queryByText("Manage favorites")).toBeNull();
  const favoriteGroup = view.container.querySelector(
    '[data-chat-model-provider-group="$favorites"]',
  )!;
  const headingIcon = favoriteGroup.querySelector(".chat-controls__provider-icon path");
  const toggleIcon = favoriteGroup.querySelector("[data-chat-model-favorite] svg path");
  expect(headingIcon).not.toBeNull();
  expect(toggleIcon).not.toBeNull();
  expect(headingIcon?.getAttribute("d")).toBe(toggleIcon?.getAttribute("d"));
  const copies = () =>
    [...view.container.querySelectorAll<HTMLButtonElement>("[data-chat-model-favorite]")].filter(
      (button) => button.getAttribute("data-chat-model-favorite") === model,
    );
  await waitForSolid(() => expect(copies()).toHaveLength(2));
  expect(copies().every((button) => button.getAttribute("aria-pressed") === "true")).toBe(true);
  const rows = [...view.container.querySelectorAll<HTMLElement>("[data-chat-model-key]")];
  expect(new Set(rows.map((row) => row.dataset.chatModelKey)).size).toBe(rows.length);
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  copies()[1]!.click();
  await waitForSolid(() => expect(Object.hasOwn(view.entries, key)).toBe(false));
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
  expect(view.container.querySelector("[data-chat-model-search]")).not.toBeNull();
  view.unmount();
});

// Cold loading is covered by browser proof; these cases exercise the loaded picker.
beforeAll(async () => {
  await import("./chat-model-picker-panel.tsx");
});

beforeEach(installModelPickerLayout);
afterEach(() => vi.restoreAllMocks());

async function mount(
  entries: Record<string, unknown> = {},
  scopes = ["operator.write"],
  overrides: Partial<ReturnType<typeof modelPickerProps>> = {},
  expand = true,
) {
  const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: { ...entries } };
    }
    if (method === "users.prefs.set") {
      const values = (params as { entries: Record<string, unknown> }).entries;
      for (const [name, value] of Object.entries(values)) {
        if (value === null) {
          delete entries[name];
        } else {
          entries[name] = value;
        }
      }
      return { status: "ok" };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  const context = createContext(request, {
    methods: ["users.prefs.get", "users.prefs.set"],
    scopes,
  });
  const gateway = createApplicationGateway({
    ...context.gateway.snapshot,
    selfUser: { id: "operator" },
  });
  const provider = createSolidApplicationContextProvider({ ...context, gateway: gateway.gateway });
  const params = modelPickerProps({
    open: true,
    sessionKey: "agent:research:main",
    modelOptions: [modelOption("openai", "large"), modelOption("openai", "small")],
    selectedModelValue: "openai/large",
    ...overrides,
  });
  const view = mountModelPicker(params, { wrapper: provider.wrapper });
  const heart = () =>
    [
      ...view.container.querySelectorAll<HTMLButtonElement>(
        '[data-chat-model-provider-group="openai"] [data-chat-model-favorite]',
      ),
    ].find((button) => button.getAttribute("data-chat-model-favorite") === model) ??
    view.container.querySelector<HTMLButtonElement>("[data-chat-model-favorite]")!;
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("users.prefs.get", { keys: [key] }),
  );
  if (expand) {
    await expandProviders(view.container);
    await waitForSolid(() => expect(heart()).toBeDefined());
  }
  return { ...view, heart, request, gateway, params, entries };
}

async function expandProviders(container: HTMLElement) {
  await waitForSolid(() =>
    expect(container.querySelector("[data-chat-model-provider-toggle]")).not.toBeNull(),
  );
  for (const toggle of container.querySelectorAll<HTMLButtonElement>(
    "[data-chat-model-provider-toggle]",
  )) {
    if (toggle.getAttribute("aria-expanded") !== "true") {
      toggle.click();
    }
  }
  flush();
}

async function expandFavorites(container: HTMLElement) {
  const toggle = () =>
    container.querySelector<HTMLButtonElement>(
      '[data-chat-model-provider-group="$favorites"] [data-chat-model-provider-toggle]',
    );
  await waitForSolid(() => expect(toggle()).not.toBeNull());
  if (toggle()!.getAttribute("aria-expanded") !== "true") {
    toggle()!.click();
  }
  await waitForSolid(() => expect(toggle()?.getAttribute("aria-expanded")).toBe("true"));
}

it("returns focus to search when removing the last focused favorite copy", async () => {
  const view = await mount({ [key]: [model] });
  await expandFavorites(view.container);
  const heart = view.container.querySelector<HTMLButtonElement>(
    '[data-chat-model-provider-group="$favorites"] [data-chat-model-favorite]',
  )!;
  await waitForSolid(() => expect(heart.disabled).toBe(false));
  heart.focus();
  heart.click();
  await waitForSolid(() => expect(Object.hasOwn(view.entries, key)).toBe(false));
  expect(document.activeElement).toBe(view.container.querySelector("[data-chat-model-search]"));
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
});

it("allows favoriting an unavailable model without enabling selection", async () => {
  const view = await mount({}, undefined, {
    modelOptions: [modelOption("openai", "small", { disabled: true })],
  });
  await waitForSolid(() => expect(view.heart().disabled).toBe(false));
  view.heart().click();
  await waitForSolid(() => expect(view.entries[key]).toEqual([model]));
  await expandFavorites(view.container);
  const favorite = view.container.querySelector<HTMLButtonElement>(
    '[data-chat-model-provider-group="$favorites"] [data-chat-model-option]',
  );
  expect(favorite?.disabled).toBe(true);
  favorite?.click();
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
});

it("saves and removes a favorite without selecting its model, then restores it on reopen", async () => {
  const view = await mount();
  await waitForSolid(() => expect(view.heart().disabled).toBe(false));
  view.heart().click();
  await expandFavorites(view.container);
  await waitForSolid(() => expect(view.heart().getAttribute("aria-pressed") === "true").toBe(true));
  await waitForSolid(() => expect(view.entries[key]).toEqual([model]));
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
  await expandFavorites(view.container);
  await waitForSolid(() =>
    expect(
      view.container.querySelector('[data-chat-model-provider-group="$favorites"]')?.textContent,
    ).toContain("small"),
  );
  expect(view.request).toHaveBeenCalledWith("users.prefs.set", {
    entries: { [key]: [model] },
    expectedEntries: { [key]: null },
  });
  view.unmount();
  const reopened = await mount(view.entries);
  await waitForSolid(() =>
    expect(reopened.heart().getAttribute("aria-pressed") === "true").toBe(true),
  );
  reopened.heart().click();
  await waitForSolid(() =>
    expect(reopened.heart().getAttribute("aria-pressed") === "true").toBe(false),
  );
  await waitForSolid(() => expect(Object.hasOwn(view.entries, key)).toBe(false));
  await waitForSolid(() =>
    expect(
      reopened.container.querySelector('[data-chat-model-provider-group="$favorites"]'),
    ).toBeNull(),
  );
});

it("identifies same-model favorites by their execution runtime", async () => {
  const view = await mount({}, undefined, {
    modelOptions: [
      modelOption("anthropic", "sonnet", {
        label: "Claude Sonnet",
        agentRuntimeId: "openclaw",
        agentRuntime: "openclaw",
      }),
      modelOption("anthropic", "sonnet", {
        label: "Claude Sonnet",
        agentRuntimeId: "claude-cli",
        agentRuntime: "claude-cli",
        runtimeOverride: "claude-cli",
      }),
    ],
  });
  const api = () =>
    view.getAllByRole<HTMLButtonElement>("button", {
      name: /(?:Add|Remove) Claude Sonnet.*API/,
    })[0]!;
  const cli = () =>
    view.getAllByRole<HTMLButtonElement>("button", {
      name: /(?:Add|Remove) Claude Sonnet.*Claude CLI/,
    })[0]!;
  await waitForSolid(() => expect(cli().disabled).toBe(false));
  cli().click();
  await expandFavorites(view.container);
  await waitForSolid(() => expect(cli().getAttribute("aria-pressed") === "true").toBe(true));
  expect(api().getAttribute("aria-pressed") === "true").toBe(false);
  expect(view.entries[key]).toEqual([JSON.stringify(["anthropic/sonnet", "claude-cli"])]);
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
});

it("keeps provider authentication and settings after favoriting its only model", async () => {
  const onProviderSettings = vi.fn();
  const view = await mount({}, undefined, {
    modelOptions: [
      modelOption("openai", "inherited", { isDefault: true }),
      modelOption("openai", "large"),
      modelOption("anthropic", "sonnet"),
    ],
    providerAuth: new Map([["anthropic", { kind: "api", label: "API key", detail: "Configured" }]]),
    onProviderSettings,
  });
  await waitForSolid(() => expect(view.heart().disabled).toBe(false));
  view.heart().click();
  await expandFavorites(view.container);
  await waitForSolid(() =>
    expect(view.heart()?.getAttribute("aria-pressed") === "true", view.container.textContent).toBe(
      true,
    ),
  );
  const heading = () => view.container.querySelector('[data-chat-model-provider="anthropic"]');
  await waitForSolid(() => expect(heading()?.textContent).toContain("API key"));
  const settings = heading()?.querySelector<HTMLButtonElement>(
    "[data-chat-model-provider-settings]",
  );
  expect(settings).not.toBeNull();
  settings!.click();
  expect(onProviderSettings).toHaveBeenCalledWith("anthropic");
  expect(heading()?.closest(".chat-controls__model-virtual-row")).not.toBeNull();
  const writes = view.request.mock.calls.filter(([method]) => method === "users.prefs.set");
  view.container
    .querySelector<HTMLButtonElement>(
      '[data-chat-model-provider-group="$favorites"] [data-chat-model-provider-toggle]',
    )!
    .click();
  await waitForSolid(() => expect(heading()).not.toBeNull());
  await expandFavorites(view.container);
  await waitForSolid(() => expect(heading()?.textContent).toContain("API key"));
  expect(view.request.mock.calls.filter(([method]) => method === "users.prefs.set")).toEqual(
    writes,
  );
  expect(view.heart().getAttribute("aria-pressed") === "true").toBe(true);
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
});

it("shows a conflicting write and reconciles the authoritative favorites", async () => {
  const view = await mount();
  await waitForSolid(() => expect(view.heart().disabled).toBe(false));
  view.request.mockImplementation(async (method) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: { [key]: [JSON.stringify(["openai/large", null])] } };
    }
    return { status: "conflict" };
  });
  view.heart().click();
  await waitForSolid(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Favorites changed",
    ),
  );
  await expandProviders(view.container);
  await waitForSolid(() =>
    expect(view.heart().getAttribute("aria-pressed") === "true").toBe(false),
  );
  expect(
    view.container.querySelector('[data-chat-model-provider-group="$favorites"]')?.textContent,
  ).toContain("large");
  const previous = [JSON.stringify(["openai/large", null])];
  const next = [...previous, model];
  view.request.mockImplementation(async (method, params) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: { [key]: next } };
    }
    expect(params).toEqual({ entries: { [key]: next }, expectedEntries: { [key]: previous } });
    return { status: "ok" };
  });
  view.heart().click();
  await waitForSolid(() => expect(view.heart().getAttribute("aria-pressed")).toBe("true"));
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
});

it.each(["viewer", "connection", "agent"])(
  "retires pending favorites on %s changes",
  async (change) => {
    const view = await mount({ [key]: [model] });
    await waitForSolid(() =>
      expect(view.heart().getAttribute("aria-pressed") === "true").toBe(true),
    );
    await waitForSolid(() => expect(view.heart().disabled).toBe(false));
    const write = createDeferred<unknown>();
    view.request.mockImplementation(async (method) =>
      method === "users.prefs.set" ? write.promise : { status: "ok", entries: {} },
    );
    view.heart().click();
    await waitForSolid(() => expect(view.heart().disabled).toBe(true));
    if (change === "viewer") {
      view.gateway.publish({
        ...view.gateway.gateway.snapshot,
        selfUser: { id: "other-operator" },
      });
    } else if (change === "connection") {
      Object.assign(view.gateway.gateway.snapshot.client!, { connectionGeneration: 1 });
      view.gateway.publish({ ...view.gateway.gateway.snapshot });
    } else {
      view.update({ ...view.params, sessionKey: "agent:other:main" });
    }
    flush();
    await waitForSolid(() =>
      expect(view.heart().getAttribute("aria-pressed") === "true").toBe(false),
    );
    await waitForSolid(() => expect(view.heart().disabled).toBe(false));
    write.resolve({ status: "conflict" });
    await waitForSolid(() => expect(view.heart().disabled).toBe(false));
    expect(view.heart().getAttribute("aria-pressed") === "true").toBe(false);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(
      view.container.querySelector('[data-chat-model-provider-group="$favorites"]'),
    ).toBeNull();
  },
);

it("restores the heart after a rejected write and retries a failed preference read", async () => {
  const view = await mount();
  await waitForSolid(() => expect(view.heart().disabled).toBe(false));
  view.request.mockImplementation(async (method) => {
    if (method === "users.prefs.set") {
      throw new Error("Favorite save rejected");
    }
    return { status: "ok", entries: {} };
  });
  view.heart().click();
  await waitForSolid(() =>
    expect(view.getByRole("alert").textContent).toContain("Favorite save rejected"),
  );
  expect(view.heart().getAttribute("aria-pressed") === "true").toBe(false);
  expect(view.heart().disabled).toBe(false);
  view.request.mockRejectedValue(new Error("Favorite read rejected"));
  view.gateway.publishEvent({
    type: "event",
    event: "users.prefs.changed",
    payload: { profileId: "operator", keys: [key] },
  });
  await waitForSolid(() => expect(view.heart().disabled).toBe(true));
  await waitForSolid(() => expect(view.container.textContent).toContain("Favorite read rejected"));
  view.request.mockResolvedValue({ status: "ok", entries: {} });
  view.getByRole("button", { name: "Retry" }).click();
  await waitForSolid(() => expect(view.heart().disabled).toBe(false));
});

it("does not write favorites without operator write access", async () => {
  const view = await mount({}, ["operator.read"]);
  expect(view.heart().disabled).toBe(true);
  view.heart().click();
  flush();
  expect(view.request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(false);
});

it("refreshes an alias viewer when its canonical profile preferences change", async () => {
  const view = await mount();
  await waitForSolid(() => expect(view.heart().disabled).toBe(false));
  view.entries[key] = [model];
  view.gateway.publishEvent({
    type: "event",
    event: "users.prefs.changed",
    payload: { profileId: "canonical-operator", keys: [key] },
  });
  await expandFavorites(view.container);
  await waitForSolid(() => expect(view.heart().getAttribute("aria-pressed") === "true").toBe(true));
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
});

it("switches agent favorites without changing catalog availability or runtime identity", async () => {
  const alternate = JSON.stringify(["openai/small", "claude-cli"]);
  const view = await mount({ [key]: [model], "ui.modelFavorites:other": [alternate] });
  const params = {
    ...view.params,
    modelOptions: [
      ...view.params.modelOptions,
      modelOption("openai", "small", { agentRuntime: "claude-cli", disabled: true }),
    ],
  };
  view.update(params);
  await waitForSolid(() => expect(view.heart().getAttribute("aria-pressed") === "true").toBe(true));
  view.update({ ...params, sessionKey: "agent:other:main" });
  await waitForSolid(() => {
    const inputs = view.container.querySelectorAll<HTMLButtonElement>("[data-chat-model-favorite]");
    for (const [identity, pressed] of [
      [model, "false"],
      [alternate, "true"],
    ]) {
      const copies = [...inputs].filter(
        (button) => button.getAttribute("data-chat-model-favorite") === identity,
      );
      expect(copies.length).toBeGreaterThan(0);
      expect(copies.every((button) => button.getAttribute("aria-pressed") === pressed)).toBe(true);
    }
  });
  await expandFavorites(view.container);
  await waitForSolid(() =>
    expect(
      view.container.querySelector(
        '[data-chat-model-provider-group="$favorites"] [data-chat-model-option]',
      ),
    ).not.toBeNull(),
  );
  const favorite = view.container.querySelector<HTMLButtonElement>(
    '[data-chat-model-provider-group="$favorites"] [data-chat-model-option]',
  );
  expect(favorite?.disabled).toBe(true);
  favorite?.click();
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
  expect(view.request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(false);
});

it("keeps authenticated favorite controls bounded and searchable for a thousand models", async () => {
  const view = await mount(
    {},
    undefined,
    {
      modelOptions: Array.from({ length: 1000 }, (_, index) =>
        modelOption("openai", `model-${index}`, {
          label: `Model ${String(index).padStart(4, "0")}`,
        }),
      ),
      selectedModelValue: "openai/model-0",
    },
    false,
  );
  const controls = () =>
    view.container.querySelectorAll<HTMLButtonElement>("[data-chat-model-favorite]");
  await expandProviders(view.container);
  await waitForSolid(() => expect(controls().length).toBeGreaterThan(0));
  expect(controls().length).toBeLessThan(40);
  view.container.querySelector<HTMLButtonElement>("[data-chat-model-more-toggle]")!.click();
  const search = view.container.querySelector<HTMLInputElement>("[data-chat-model-search]")!;
  search.value = "Model 0999";
  search.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await waitForSolid(() => expect(controls()).toHaveLength(1));
  expect(controls()[0]!.getAttribute("data-chat-model-favorite")).toBe(
    JSON.stringify(["openai/model-999", null]),
  );
  controls()[0]!.click();
  await waitForSolid(() =>
    expect(view.entries[key]).toEqual([JSON.stringify(["openai/model-999", null])]),
  );
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
  await waitForSolid(() => expect(controls()).toHaveLength(2));
  expect([...controls()].every((button) => button.getAttribute("aria-pressed") === "true")).toBe(
    true,
  );
});

it.each(["identity", "model lock"])(
  "restores inline favorite controls after a temporary %s change",
  async (boundary) => {
    const view = await mount();
    const controls = () => view.container.querySelectorAll("[data-chat-model-favorite]");
    expect(controls().length).toBeGreaterThan(0);
    const connected = view.gateway.gateway.snapshot;
    if (boundary === "identity") {
      view.gateway.publish({ ...connected, selfUser: undefined });
    } else {
      view.update({ ...view.params, modelSelectionLocked: true });
    }
    await waitForSolid(() => expect(controls()).toHaveLength(0));
    if (boundary === "identity") {
      view.gateway.publish(connected);
    } else {
      view.update(view.params);
    }
    await expandProviders(view.container);
    await waitForSolid(() => expect(controls().length).toBeGreaterThan(0));
  },
);
