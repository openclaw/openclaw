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
const model = "openai/small";

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
      const { entries: values, expectedEntries } = params as {
        entries: Record<string, unknown>;
        expectedEntries: Record<string, unknown>;
      };
      if (
        Object.entries(expectedEntries).some(
          ([name, expected]) => JSON.stringify(entries[name] ?? null) !== JSON.stringify(expected),
        )
      ) {
        return { status: "conflict" };
      }
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
    modelOptions: [
      modelOption("openai", "large"),
      modelOption("openai", "small"),
      modelOption("anthropic", "sonnet"),
    ],
    selectedModelValue: "openai/large",
    ...overrides,
  });
  const view = mountModelPicker(params, { wrapper: provider.wrapper });
  const star = (value = model) =>
    [...view.container.querySelectorAll<HTMLButtonElement>("[data-chat-model-favorite]")].find(
      (button) => button.getAttribute("data-chat-model-favorite") === value,
    )!;
  await waitForSolid(() =>
    expect(request).toHaveBeenCalledWith("users.prefs.get", { keys: [key] }),
  );
  if (expand) {
    await waitForSolid(() =>
      expect(view.container.querySelector("[data-chat-model-favorite]")).not.toBeNull(),
    );
  }
  return { ...view, star, request, gateway, params, entries };
}

async function selectProvider(container: HTMLElement, provider: string) {
  const toggle = () =>
    container.querySelector<HTMLButtonElement>(`[data-chat-model-provider-toggle="${provider}"]`);
  await waitForSolid(() => expect(toggle()).not.toBeNull());
  toggle()!.click();
  await waitForSolid(() => expect(toggle()?.getAttribute("aria-selected")).toBe("true"));
}

async function reopen(view: Awaited<ReturnType<typeof mount>>) {
  view.update({ ...view.params, open: false });
  await waitForSolid(() =>
    expect(
      view.container.querySelector("[data-chat-model-search]")?.getAttribute("aria-expanded"),
    ).toBe("false"),
  );
  view.update(view.params);
  await waitForSolid(() =>
    expect(view.container.querySelector("[data-chat-model-favorite]")).not.toBeNull(),
  );
}

function rowValues(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>("[data-chat-model-option]")].map(
    (row) => row.dataset.chatModelOption,
  );
}

it("normalizes legacy runtime entries without writing on read, and keeps the raw compare-and-set", async () => {
  const raw = [
    JSON.stringify([model, "openclaw"]),
    "anthropic/sonnet",
    JSON.stringify([model, "claude-cli"]),
    "unknown/plain",
    '[7,"retained"]',
  ];
  const view = await mount({ [key]: raw });
  await waitForSolid(() => expect(view.star().getAttribute("aria-pressed")).toBe("true"));
  expect(view.request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(false);
  await selectProvider(view.container, "$favorites");
  expect(rowValues(view.container)).toEqual([model, "anthropic/sonnet"]);
  await selectProvider(view.container, "openai");
  view.star("openai/large").click();
  const normalized = [model, "anthropic/sonnet", "unknown/plain", '[7,"retained"]', "openai/large"];
  await waitForSolid(() => expect(view.entries[key]).toEqual(normalized));
  expect(view.request).toHaveBeenCalledWith("users.prefs.set", {
    entries: { [key]: normalized },
    expectedEntries: { [key]: raw },
  });
});

it("uses the same favorite across runtimes while retaining distinct row identities", async () => {
  const view = await mount({}, undefined, {
    modelOptions: ["openclaw", "codex"].flatMap((runtime) => [
      modelOption("openai", "large", {
        agentRuntime: runtime,
        agentRuntimeId: runtime,
        runtimeOverride: runtime,
      }),
      modelOption("openai", "small", {
        agentRuntime: runtime,
        agentRuntimeId: runtime,
        runtimeOverride: runtime,
      }),
    ]),
    selectedAgentRuntime: "openclaw",
  });
  view.params.onModelSelect = vi.fn(async (value, _session, runtime) => {
    view.params.selectedModelValue = value;
    view.params.selectedAgentRuntime = runtime ?? undefined;
    view.update({ ...view.params });
  });
  view.update({ ...view.params });
  await waitForSolid(() => expect(view.star().disabled).toBe(false));
  const firstKey = view.star().closest<HTMLElement>("[data-chat-model-key]")!.dataset.chatModelKey;
  view.star().click();
  await waitForSolid(() => expect(view.entries[key]).toEqual([model]));
  await waitForSolid(() => expect(view.star().getAttribute("aria-pressed")).toBe("true"));
  view.container
    .querySelector<HTMLButtonElement>('button[data-chat-model-runtime="codex"]')!
    .click();
  await waitForSolid(() =>
    expect(
      view.container
        .querySelector('button[data-chat-model-runtime="codex"]')
        ?.getAttribute("aria-pressed"),
    ).toBe("true"),
  );
  expect(view.star().getAttribute("aria-pressed")).toBe("true");
  expect(view.star().closest<HTMLElement>("[data-chat-model-key]")!.dataset.chatModelKey).not.toBe(
    firstKey,
  );
  expect(view.container.querySelector('[data-chat-model-provider-toggle="$favorites"]')).toBeNull();
  view.star().click();
  await waitForSolid(() => expect(Object.hasOwn(view.entries, key)).toBe(false));
});

it("freezes provider order and rail membership until reopening", async () => {
  const view = await mount({}, undefined, {
    modelOptions: [
      modelOption("openai", "default", { isDefault: true }),
      modelOption("openai", "recommended", { recommended: true }),
      modelOption("openai", "large"),
      modelOption("openai", "small"),
      modelOption("openai", "other"),
      modelOption("anthropic", "sonnet"),
    ],
  });
  view.container.querySelector<HTMLButtonElement>("[data-chat-model-more-toggle]")!.click();
  await waitForSolid(() => expect(view.star()).toBeDefined());
  const before = rowValues(view.container);
  expect(before).toEqual([
    "openai/default",
    "openai/large",
    "openai/recommended",
    model,
    "openai/other",
  ]);
  expect(
    view.container.querySelector(
      '[data-chat-model-option="openai/default"] [data-chat-model-favorite]',
    ),
  ).toBeNull();
  view.star().click();
  await waitForSolid(() => expect(view.entries[key]).toEqual([model]));
  expect(rowValues(view.container)).toEqual(before);
  expect(view.container.querySelector('[data-chat-model-provider-toggle="$favorites"]')).toBeNull();
  await reopen(view);
  expect(rowValues(view.container)).toEqual([
    "openai/default",
    "openai/large",
    model,
    "openai/recommended",
    "openai/other",
  ]);
  const tabs = [
    ...view.container.querySelectorAll<HTMLButtonElement>("[data-chat-model-provider-toggle]"),
  ];
  expect(tabs[0]?.dataset.chatModelProviderToggle).toBe("$favorites");
  expect(tabs[0]?.draggable).toBe(false);
  await selectProvider(view.container, "$favorites");
  expect(rowValues(view.container)).toEqual([model]);
  view.star().click();
  await waitForSolid(() => expect(Object.hasOwn(view.entries, key)).toBe(false));
  expect(rowValues(view.container)).toEqual([model]);
  await waitForSolid(() => expect(view.star().getAttribute("aria-pressed")).toBe("false"));
  expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
  await reopen(view);
  expect(view.container.querySelector('[data-chat-model-provider-toggle="$favorites"]')).toBeNull();
});

it("returns focus to search when removing the last focused favorite copy", async () => {
  const view = await mount({ [key]: [model] });
  await selectProvider(view.container, "$favorites");
  const star = view.container.querySelector<HTMLButtonElement>(
    '[data-chat-model-provider-group="$favorites"] [data-chat-model-favorite]',
  )!;
  await waitForSolid(() => expect(star.disabled).toBe(false));
  star.focus();
  star.click();
  await waitForSolid(() => expect(Object.hasOwn(view.entries, key)).toBe(false));
  expect(document.activeElement).toBe(view.container.querySelector("[data-chat-model-search]"));
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
});

it("allows favoriting an unavailable model without enabling selection", async () => {
  const view = await mount({}, undefined, {
    modelOptions: [
      modelOption("openai", "small", { disabled: true }),
      modelOption("anthropic", "sonnet"),
    ],
  });
  await waitForSolid(() => expect(view.star().disabled).toBe(false));
  view.star().click();
  await waitForSolid(() => expect(view.entries[key]).toEqual([model]));
  await reopen(view);
  await selectProvider(view.container, "$favorites");
  const favorite = view.container.querySelector<HTMLElement>("[data-chat-model-option]")!;
  expect(favorite.getAttribute("aria-disabled")).toBe("true");
  favorite.click();
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
});

it("saves and removes a favorite without selecting its model, then restores it on reopen", async () => {
  const view = await mount();
  await waitForSolid(() => expect(view.star().disabled).toBe(false));
  view.star().click();
  await waitForSolid(() => expect(view.entries[key]).toEqual([model]));
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
  expect(view.request).toHaveBeenCalledWith("users.prefs.set", {
    entries: { [key]: [model] },
    expectedEntries: { [key]: null },
  });
  await reopen(view);
  await selectProvider(view.container, "$favorites");
  expect(view.star().getAttribute("aria-pressed")).toBe("true");
  expect(view.container.querySelector('[data-chat-model-provider="$favorites"]')?.textContent).toBe(
    "Favorites",
  );
  expect(view.container.querySelector("[data-chat-model-provider-settings]")).toBeNull();
  expect(view.container.querySelector("[data-chat-model-runtime]")).toBeNull();
  view.star().click();
  await waitForSolid(() => expect(Object.hasOwn(view.entries, key)).toBe(false));
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
});

it("keeps provider authentication and settings after favoriting its only model", async () => {
  const onProviderSettings = vi.fn();
  const view = await mount({}, undefined, {
    modelOptions: [modelOption("openai", "large"), modelOption("anthropic", "sonnet")],
    providerAuth: new Map([["anthropic", { kind: "api", label: "API key", detail: "Configured" }]]),
    onProviderSettings,
  });
  await selectProvider(view.container, "anthropic");
  await waitForSolid(() => expect(view.star("anthropic/sonnet").disabled).toBe(false));
  view.star("anthropic/sonnet").click();
  await waitForSolid(() => expect(view.entries[key]).toEqual(["anthropic/sonnet"]));
  await reopen(view);
  await selectProvider(view.container, "$favorites");
  expect(view.container.querySelector("[data-chat-model-provider-settings]")).toBeNull();
  await selectProvider(view.container, "anthropic");
  const heading = view.container.querySelector('[data-chat-model-provider="anthropic"]')!;
  expect(heading.textContent).toContain("API key");
  heading.querySelector<HTMLButtonElement>("[data-chat-model-provider-settings]")!.click();
  expect(onProviderSettings).toHaveBeenCalledWith("anthropic");
  expect(view.star("anthropic/sonnet").getAttribute("aria-pressed")).toBe("true");
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
});

it("shows a conflicting write and reconciles the authoritative favorites", async () => {
  const view = await mount();
  await waitForSolid(() => expect(view.star().disabled).toBe(false));
  view.request.mockImplementation(async (method) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: { [key]: [JSON.stringify(["openai/large", null])] } };
    }
    return { status: "conflict" };
  });
  view.star().click();
  await waitForSolid(() =>
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Favorites changed",
    ),
  );
  await selectProvider(view.container, "openai");
  await waitForSolid(() => expect(view.star().getAttribute("aria-pressed") === "true").toBe(false));
  expect(view.star("openai/large").getAttribute("aria-pressed")).toBe("true");
  const previous = [JSON.stringify(["openai/large", null])];
  const next = ["openai/large", model];
  view.request.mockImplementation(async (method, params) => {
    if (method === "users.prefs.get") {
      return { status: "ok", entries: { [key]: next } };
    }
    expect(params).toEqual({ entries: { [key]: next }, expectedEntries: { [key]: previous } });
    return { status: "ok" };
  });
  view.star().click();
  await waitForSolid(() => expect(view.star().getAttribute("aria-pressed")).toBe("true"));
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
});

it.each(["viewer", "connection", "agent"])(
  "retires pending favorites on %s changes",
  async (change) => {
    const view = await mount({ [key]: [model] });
    await waitForSolid(() =>
      expect(view.star().getAttribute("aria-pressed") === "true").toBe(true),
    );
    await waitForSolid(() => expect(view.star().disabled).toBe(false));
    const write = createDeferred<unknown>();
    view.request.mockImplementation(async (method) =>
      method === "users.prefs.set" ? write.promise : { status: "ok", entries: {} },
    );
    view.star().click();
    await waitForSolid(() => expect(view.star().disabled).toBe(true));
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
      expect(view.star().getAttribute("aria-pressed") === "true").toBe(false),
    );
    await waitForSolid(() => expect(view.star().disabled).toBe(false));
    write.resolve({ status: "conflict" });
    await waitForSolid(() => expect(view.star().disabled).toBe(false));
    expect(view.star().getAttribute("aria-pressed") === "true").toBe(false);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
    expect(
      view.container.querySelector('[data-chat-model-provider-group="$favorites"]'),
    ).toBeNull();
  },
);

it("restores the star after a rejected write and retries a failed preference read", async () => {
  const view = await mount();
  await waitForSolid(() => expect(view.star().disabled).toBe(false));
  view.request.mockImplementation(async (method) => {
    if (method === "users.prefs.set") {
      throw new Error("Favorite save rejected");
    }
    return { status: "ok", entries: {} };
  });
  view.star().click();
  await waitForSolid(() =>
    expect(view.getByRole("alert").textContent).toContain("Favorite save rejected"),
  );
  expect(view.star().getAttribute("aria-pressed") === "true").toBe(false);
  expect(view.star().disabled).toBe(false);
  view.request.mockRejectedValue(new Error("Favorite read rejected"));
  view.gateway.publishEvent({
    type: "event",
    event: "users.prefs.changed",
    payload: { profileId: "operator", keys: [key] },
  });
  await waitForSolid(() => expect(view.star().disabled).toBe(true));
  await waitForSolid(() => expect(view.container.textContent).toContain("Favorite read rejected"));
  view.request.mockResolvedValue({ status: "ok", entries: {} });
  view.getByRole("button", { name: "Retry" }).click();
  await waitForSolid(() => expect(view.star().disabled).toBe(false));
});

it("does not write favorites without operator write access", async () => {
  const view = await mount({}, ["operator.read"]);
  expect(view.star().disabled).toBe(true);
  view.star().click();
  flush();
  expect(view.request.mock.calls.some(([method]) => method === "users.prefs.set")).toBe(false);
});

it("refreshes an alias viewer when its canonical profile preferences change", async () => {
  const view = await mount();
  await waitForSolid(() => expect(view.star().disabled).toBe(false));
  view.entries[key] = [model];
  view.gateway.publishEvent({
    type: "event",
    event: "users.prefs.changed",
    payload: { profileId: "canonical-operator", keys: [key] },
  });
  await waitForSolid(() => expect(view.star().getAttribute("aria-pressed") === "true").toBe(true));
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
});

it("switches agent favorites and retains saved favorites when catalog access changes", async () => {
  const view = await mount({ [key]: [model], "ui.modelFavorites:other": ["openai/large"] });
  await waitForSolid(() => expect(view.star().getAttribute("aria-pressed")).toBe("true"));
  const otherAgent = { ...view.params, sessionKey: "agent:other:main" };
  view.update(otherAgent);
  await waitForSolid(() => expect(view.star().getAttribute("aria-pressed")).toBe("false"));
  expect(view.star("openai/large").getAttribute("aria-pressed")).toBe("true");

  view.update({
    ...otherAgent,
    modelOptions: view.params.modelOptions.filter((option) => option.value !== "openai/large"),
  });
  await waitForSolid(() =>
    expect(
      view.container.querySelector('[data-chat-model-provider-toggle="$favorites"]'),
    ).toBeNull(),
  );
  expect(view.entries).toEqual({
    [key]: [model],
    "ui.modelFavorites:other": ["openai/large"],
  });

  view.update(otherAgent);
  await waitForSolid(() =>
    expect(view.star("openai/large")?.getAttribute("aria-pressed")).toBe("true"),
  );
  expect(
    view.container.querySelector('[data-chat-model-provider-toggle="$favorites"]'),
  ).not.toBeNull();
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
  await waitForSolid(() => expect(controls().length).toBeGreaterThan(0));
  expect(controls().length).toBeLessThan(40);
  view.container.querySelector<HTMLButtonElement>("[data-chat-model-more-toggle]")!.click();
  const search = view.container.querySelector<HTMLInputElement>("[data-chat-model-search]")!;
  search.value = "Model 0999";
  search.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await waitForSolid(() => expect(controls()).toHaveLength(1));
  expect(controls()[0]!.getAttribute("data-chat-model-favorite")).toBe("openai/model-999");
  controls()[0]!.click();
  await waitForSolid(() => expect(view.entries[key]).toEqual(["openai/model-999"]));
  expect(view.params.onModelSelect).not.toHaveBeenCalled();
  await waitForSolid(() => expect(controls()).toHaveLength(1));
  await waitForSolid(() => expect(controls()[0]?.getAttribute("aria-pressed")).toBe("true"));
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
    await selectProvider(view.container, "openai");
    await waitForSolid(() => expect(controls().length).toBeGreaterThan(0));
  },
);
