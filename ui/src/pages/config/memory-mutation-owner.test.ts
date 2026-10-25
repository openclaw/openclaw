/* @vitest-environment jsdom */

import { setImmediate as nextTurn } from "node:timers/promises";
import { createRouter, definePage } from "@openclaw/uirouter";
import { createComponent } from "solid-js";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { RouterOutlet } from "../../app/router-outlet.tsx";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { setPluginEnabled } from "../../lib/plugins/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { completeConfigContext, mountConfigPage } from "./config-page.test-support.ts";
import { ConfigPage } from "./config-page.tsx";
import {
  mountMemoryPage,
  memoryTabRoute,
  activeEngine,
  addonSwitch,
  createMemoryPage,
  createMemoryTestAddon as addon,
  createMemoryTestDeferred as deferred,
  createMemoryTestEngine as engine,
  createMemoryTestMutationResult as committed,
  selectEngine,
  toggleAddon,
} from "./memory-page.test-support.tsx";
import "./memory-page.tsx";

vi.mock("../../lib/plugins/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/plugins/index.ts")>();
  return { ...actual, setPluginEnabled: vi.fn() };
});

function addons() {
  return [addon("active-memory", true), addon("memory-wiki", false)];
}
async function finishMemory(
  element: HTMLElement,
  mutation: ReturnType<typeof createMemoryPage>["runExternalMutation"],
) {
  await Promise.allSettled(mutation.mock.results.map(({ value }) => value));
  element.remove();
}
function waitForCatalog(request: ReturnType<typeof createMemoryPage>["request"], count: number) {
  return waitForSolid(() =>
    expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(count),
  );
}
function waitForAddon(element: HTMLElement, state: { checked?: boolean; disabled?: boolean } = {}) {
  return waitForSolid(() => {
    const control = addonSwitch(element, "Active memory");
    expect(control).not.toBeNull();
    if (state.checked !== undefined) {
      expect(control?.checked).toBe(state.checked);
    }
    if (state.disabled !== undefined) {
      expect(control?.hasAttribute("aria-disabled")).toBe(state.disabled);
    }
  });
}

beforeEach(() => {
  vi.mocked(setPluginEnabled).mockReset();
});

it("keeps a later add-on pending through the real configuration owner", async () => {
  const engineReply = deferred<unknown>();
  const addonReply = deferred<unknown>();
  let configObject = { plugins: { slots: { memory: "memory-core" } } };
  const { context } = createMemoryPage({
    configObject,
    methods: ["config.get", "config.set", "config.schema.lookup"],
    listCatalog: () =>
      Promise.resolve({
        plugins: [
          engine("memory-core", true),
          engine("other", configObject.plugins.slots.memory === "other"),
          addon("active-memory", false),
        ],
      }),
    settingsRequest: async (method) =>
      method === "config.get"
        ? {
            config: configObject,
            sourceConfig: configObject,
            hash: "memory-actions",
            valid: true,
            issues: [],
          }
        : { type: "object" },
    setEnabled: async (id) => {
      if (id !== "other") {
        return addonReply.promise;
      }
      const result = await engineReply.promise;
      configObject = { plugins: { slots: { memory: "other" } } };
      return result;
    },
  });
  const runtimeConfig = createRuntimeConfigCapability(context.gateway);
  Object.assign(context, { runtimeConfig });
  const runExternalMutation = vi.spyOn(runtimeConfig, "runExternalMutation");
  await runtimeConfig.ensureLoaded();
  const view = mountConfigPage(context, {
    pageId: "memory",
    routeData: memoryTabRoute("settings"),
  });
  try {
    await waitForSolid(() => expect(activeEngine(view.page)).toBe("memory-core"));
    selectEngine(view.page, "other");
    await waitForSolid(() => expect(activeEngine(view.page)).toBe("other"));
    expect(view.page.textContent).not.toContain("This engine is disabled");
    toggleAddon(view.page, "Active memory", true);
    await waitForSolid(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));
    await waitForSolid(() => {
      expect(addonSwitch(view.page, "Active memory")?.checked).toBe(true);
      expect(addonSwitch(view.page, "Active memory")?.hasAttribute("aria-disabled")).toBe(true);
    });
    engineReply.resolve(committed("other", true));
    await waitForSolid(() =>
      expect(setPluginEnabled).toHaveBeenCalledWith(expect.anything(), "active-memory", true),
    );
    await waitForSolid(() => {
      expect(activeEngine(view.page)).toBe("other");
      expect(
        view.page
          .querySelector(".settings-segmented__input:checked")
          ?.hasAttribute("aria-disabled"),
      ).toBe(false);
      expect(addonSwitch(view.page, "Active memory")?.hasAttribute("aria-disabled")).toBe(true);
      expect(view.page.textContent).not.toContain("This engine is disabled");
    });
  } finally {
    engineReply.resolve(committed("other", true));
    addonReply.resolve(committed("active-memory", true));
    await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
    view.dispose();
    runtimeConfig.dispose();
  }
});

it("finishes one add-on while its admitted sibling is still pending", async () => {
  const processInfo = deferred<{ processInstanceId: string }>();
  const first = deferred<unknown>();
  const second = deferred<unknown>();
  const setEnabled = vi.fn((pluginId: string) =>
    pluginId === "active-memory" ? first.promise : second.promise,
  );
  const { element, request, runExternalMutation } = createMemoryPage({
    configObject: {},
    catalog: addons(),
    processInfo: () => processInfo.promise,
    setEnabled,
  });
  mountMemoryPage(element);
  try {
    await waitForAddon(element);
    toggleAddon(element, "Active memory", false);
    // Browser input events occupy separate turns, even while the first request is pending.
    await nextTurn();
    toggleAddon(element, "Memory wiki", true);
    await waitForSolid(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));
    await waitForSolid(() => {
      expect(addonSwitch(element, "Active memory")?.checked).toBe(false);
      expect(addonSwitch(element, "Memory wiki")?.checked).toBe(true);
    });
    expect(setEnabled).toHaveBeenCalledExactlyOnceWith("active-memory", false);
    first.resolve(committed("active-memory", false, ["Review active-memory settings."]));
    await waitForSolid(() => expect(setEnabled).toHaveBeenCalledWith("memory-wiki", true));
    await waitForSolid(() => {
      expect(addonSwitch(element, "Active memory")?.hasAttribute("aria-disabled")).toBe(false);
      expect(addonSwitch(element, "Memory wiki")?.hasAttribute("aria-disabled")).toBe(true);
    });
    second.resolve(committed("memory-wiki", true, ["Review memory-wiki settings."]));
    await waitForSolid(() => {
      expect(element.textContent).toContain("Review active-memory settings.");
      expect(element.textContent).toContain("Review memory-wiki settings.");
    });
    expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(0);
  } finally {
    processInfo.resolve({ processInstanceId: "memory-process" });
    first.resolve(committed("active-memory", false));
    second.resolve(committed("memory-wiki", true));

    await finishMemory(element, runExternalMutation);
  }
});

it("leaves Memory through RouterOutlet while an add-on mutation is pending", async () => {
  const pending = createDeferred<unknown>();
  const { element, context, runExternalMutation } = createMemoryPage({
    configObject: {},
    catalog: [addon("active-memory", true)],
    setEnabled: () => pending.promise,
  });
  // The routed ConfigPage gates controls on the config capability.
  Object.assign(context.runtimeConfig, { canSet: true });
  const memoryModule = {
    renderSolid: () =>
      createComponent(ConfigPage, { pageId: "memory", routeData: element.routeData }),
  };
  const router = createRouter<RouteId, ApplicationContext, typeof memoryModule>({
    routes: [
      definePage({ id: "memory", path: "/settings/memory/:tab?", component: () => memoryModule }),
      definePage({
        id: "usage",
        path: "/usage",
        component: () => ({
          renderSolid: () => {
            const body = document.createElement("p");
            body.textContent = "Memory destination: /usage";
            return body;
          },
        }),
      }),
    ],
  });
  Object.assign(context, { router });
  const provider = createSolidApplicationContextProvider(completeConfigContext(context));
  const page = mountSolid(() => createComponent(RouterOutlet, { router, retryContext: context }), {
    wrapper: provider.wrapper,
  });
  let navigation: Promise<unknown> | undefined;
  try {
    await router.navigate(
      "memory",
      context,
      {},
      {
        pathname: "/settings/memory/settings",
        search: "",
        hash: "",
      },
    );
    await waitForSolid(() =>
      expect(
        addonSwitch(page.container, "Active memory"),
        page.container.textContent ?? "",
      ).not.toBeNull(),
    );
    const oldHost = page.container.querySelector("openclaw-config-page")!;
    toggleAddon(page.container, "Active memory", false);
    await waitForSolid(() => expect(runExternalMutation).toHaveBeenCalledOnce());
    await waitForSolid(() => expect(setPluginEnabled).toHaveBeenCalledOnce());
    navigation = router.navigate("usage", context);
    await waitForSolid(() => {
      expect(page.container.textContent).toContain("Memory destination: /usage");
      expect(oldHost.isConnected).toBe(false);
      expect(page.container.querySelector("openclaw-config-page")).toBeNull();
      expect(addonSwitch(page.container, "Active memory")).toBeNull();
    });
    await navigation;
    pending.reject(new Error("Late Memory failure"));
    await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
    await waitForSolid(() => {
      expect(page.container.textContent).toContain("Memory destination: /usage");
      expect(page.container.querySelector("openclaw-config-page")).toBeNull();
      expect(page.container.querySelector('[role="alert"]')).toBeNull();
      expect(page.container.textContent).not.toContain("Late Memory failure");
    });
  } finally {
    pending.resolve(committed("active-memory", false));
    await Promise.allSettled([
      pending.promise,
      navigation,
      ...runExternalMutation.mock.results.map(({ value }) => value),
    ]);
    page.unmount();
    router.stop();
  }
});

it.each([
  ["reconnect", true],
  ["boot", true],
  ["admin scope", true],
  ["read-only catalog", true],
  ["admin scope", false],
  ["read-only catalog", false],
] as const)("retires an add-on mutation after %s changes (queued=%s)", async (change, queued) => {
  const pendingWrites = deferred<void>();
  const oldReply = createDeferred<unknown>();
  let mutationCalls = 0;
  const setEnabled = vi.fn((pluginId: string, enabled: boolean) =>
    !queued && mutationCalls++ === 0
      ? oldReply.promise
      : Promise.resolve(committed(pluginId, enabled)),
  );
  let mutationAllowed = true;
  const { element, runExternalMutation, setPhase, setBootId, setScopes, publishPluginGeneration } =
    createMemoryPage({
      configObject: {},
      listCatalog: () =>
        Promise.resolve({
          plugins: [addon("active-memory", true)],
          mutationAllowed,
        }),
      waitForPendingWrites: queued ? () => pendingWrites.promise : undefined,
      setEnabled,
    });
  mountMemoryPage(element);
  try {
    await waitForAddon(element);
    toggleAddon(element, "Active memory", false);
    await waitForSolid(() => expect(runExternalMutation).toHaveBeenCalledOnce());
    if (!queued) {
      await waitForSolid(() => expect(setEnabled).toHaveBeenCalledOnce());
    }
    if (change === "reconnect") {
      setPhase("disconnected");
      setPhase("connected");
    } else if (change === "boot") {
      setBootId("memory-boot-b");
    } else if (change === "admin scope") {
      setScopes(["operator.read"]);
    } else {
      mutationAllowed = false;
      publishPluginGeneration(1);
      await waitForSolid(() => expect(addonSwitch(element, "Active memory")).toBeNull());
    }
    if (queued) {
      pendingWrites.resolve();
      await runExternalMutation.mock.results[0]?.value;
      expect(setEnabled).not.toHaveBeenCalled();
      if (change === "reconnect" || change === "boot") {
        expect(element.textContent).not.toContain("Could not update Active memory");
      }
    } else {
      await waitForSolid(() => expect(addonSwitch(element, "Active memory")).toBeNull());
      if (change === "admin scope") {
        setScopes(["operator.admin"]);
      } else {
        mutationAllowed = true;
        publishPluginGeneration(2);
      }
      await waitForAddon(element);
      toggleAddon(element, "Active memory", false);
      await waitForSolid(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));
      oldReply.reject(new Error("retired add-on failure"));
      await waitForSolid(() => expect(setEnabled).toHaveBeenCalledTimes(2));
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      flush();
      expect(element.textContent).not.toContain("retired add-on failure");
    }
  } finally {
    pendingWrites.resolve();
    oldReply.resolve(committed("active-memory", false));
    await finishMemory(element, runExternalMutation);
  }
});

it.each(["queued", "in flight"])(
  "preserves a %s add-on mutation and its busy state across plugin publications",
  async (phase) => {
    const pendingWrites = deferred<void>();
    const reply = deferred<unknown>();
    const setEnabled = vi.fn(() => reply.promise);
    const { element, runExternalMutation, publishPluginGeneration } = createMemoryPage({
      configObject: {},
      catalog: [addon("active-memory", true)],
      waitForPendingWrites: () => pendingWrites.promise,
      setEnabled,
    });
    mountMemoryPage(element);
    try {
      await waitForAddon(element);
      toggleAddon(element, "Active memory", false);
      await waitForSolid(() => expect(runExternalMutation).toHaveBeenCalledOnce());
      if (phase === "in flight") {
        pendingWrites.resolve();
        await waitForSolid(() => expect(setEnabled).toHaveBeenCalledOnce());
      }
      publishPluginGeneration(1);
      publishPluginGeneration(1);
      await waitForAddon(element, { disabled: true });
      expect(setEnabled).toHaveBeenCalledTimes(phase === "queued" ? 0 : 1);
      pendingWrites.resolve();
      await waitForSolid(() => expect(setEnabled).toHaveBeenCalledOnce());
      reply.resolve(committed("active-memory", false, ["Review active-memory settings."]));
      await waitForSolid(() =>
        expect(element.textContent).toContain("Review active-memory settings."),
      );
      await waitForAddon(element, { disabled: false });
      expect(runExternalMutation).toHaveBeenCalledOnce();
    } finally {
      pendingWrites.resolve();
      reply.resolve(committed("active-memory", false));

      await finishMemory(element, runExternalMutation);
    }
  },
);

it.each(["add-on", "engine"] as const)(
  "keeps the replacement %s busy after an older connection finishes",
  async (kind) => {
    const firstMutation = deferred<unknown>();
    const secondMutation = deferred<unknown>();
    let mutationCalls = 0;
    const setEnabled = vi.fn(() =>
      mutationCalls++ === 0 ? firstMutation.promise : secondMutation.promise,
    );
    const isEngine = kind === "engine";
    const pluginId = isEngine ? "other" : "active-memory";
    const { element, request, runExternalMutation, setPhase } = createMemoryPage({
      configObject: {},
      catalog: isEngine
        ? [engine("memory-core", true), engine("other", false)]
        : [addon("active-memory", true)],
      setEnabled,
    });
    const expectReady = () => {
      if (isEngine) {
        expect(activeEngine(element)).toBe("memory-core");
      } else {
        expect(addonSwitch(element, "Active memory")).not.toBeNull();
      }
    };
    const change = () =>
      isEngine ? selectEngine(element, "other") : toggleAddon(element, "Active memory", false);
    const control = () =>
      isEngine
        ? element.querySelector(".settings-segmented__input")
        : addonSwitch(element, "Active memory");
    mountMemoryPage(element);
    try {
      await waitForSolid(expectReady);
      change();
      await waitForSolid(() => expect(setEnabled).toHaveBeenCalledOnce());

      setPhase("disconnected");
      setPhase("connected");
      await waitForCatalog(request, 2);
      await waitForSolid(expectReady);
      change();
      await waitForSolid(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));

      firstMutation.resolve(committed(pluginId, isEngine));
      await waitForSolid(() => expect(setEnabled).toHaveBeenCalledTimes(2));
      await waitForCatalog(request, 3);
      expect(element.textContent).not.toContain("Could not change the memory engine");
      flush();
      expect(control()?.hasAttribute("aria-disabled")).toBe(true);

      secondMutation.resolve(committed(pluginId, isEngine));
      await waitForSolid(() => expect(control()?.hasAttribute("aria-disabled")).toBe(false));
    } finally {
      firstMutation.resolve(committed(pluginId, isEngine));
      secondMutation.resolve(committed(pluginId, isEngine));

      await finishMemory(element, runExternalMutation);
    }
  },
);

it("clears a runtime warning after a newer successful mutation of the same add-on", async () => {
  let enabled = true;
  let attempts = 0;
  const { element, runExternalMutation } = createMemoryPage({
    configObject: {},
    listCatalog: () => Promise.resolve({ plugins: [addon("active-memory", enabled)] }),
    setEnabled: (pluginId, nextEnabled) => {
      enabled = nextEnabled;
      return Promise.resolve(
        committed(pluginId, enabled, attempts++ === 0 ? ["Earlier runtime warning."] : []),
      );
    },
  });
  mountMemoryPage(element);
  try {
    await waitForAddon(element, { checked: true });
    toggleAddon(element, "Active memory", false);
    await waitForSolid(() => expect(element.textContent).toContain("Earlier runtime warning."));
    await waitForAddon(element, { disabled: false });
    toggleAddon(element, "Active memory", true);
    await waitForSolid(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));
    await waitForSolid(() => expect(element.textContent).not.toContain("Earlier runtime warning."));
    await waitForAddon(element, { checked: true });
  } finally {
    await finishMemory(element, runExternalMutation);
  }
});

it.each(["memory-boot-b", undefined])(
  "does not insert an old runtime warning after the boot ID changes to %s",
  async (bootId) => {
    const reply = deferred<unknown>();
    const setEnabled = vi.fn(() => reply.promise);
    const { element, request, runExternalMutation, setBootId } = createMemoryPage({
      configObject: {},
      catalog: [addon("active-memory", true)],
      setEnabled,
    });
    mountMemoryPage(element);
    try {
      await waitForAddon(element);
      toggleAddon(element, "Active memory", false);
      await waitForSolid(() => expect(setEnabled).toHaveBeenCalledOnce());
      setBootId(bootId);
      await waitForAddon(element, { disabled: false });
      reply.resolve(committed("active-memory", false, ["Old boot runtime warning."]));
      await runExternalMutation.mock.results[0]?.value;
      await waitForCatalog(request, 3);
      flush();
      expect(element.textContent).not.toContain("Old boot runtime warning.");
      expect(element.textContent).not.toContain("Could not update Active memory");
    } finally {
      reply.resolve(committed("active-memory", false));

      await finishMemory(element, runExternalMutation);
    }
  },
);

it.each([
  ["active-memory", "memory-wiki"],
  ["engine", "active-memory"],
  ["active-memory", "engine"],
  ["active-memory", "reconnect"],
] as const)(
  "clears a %s refresh warning when %s refreshes authoritative configuration",
  async (first, second) => {
    let refreshCalls = 0;
    const { element, runExternalMutation, setPhase } = createMemoryPage({
      configObject: {},
      catalog: [
        engine("memory-core", true),
        engine("other", false),
        addon("active-memory", true),
        addon("memory-wiki", false),
      ],
      refresh: () =>
        refreshCalls++ === 0
          ? Promise.reject(new Error("previous authoritative refresh failed"))
          : Promise.resolve(),
      setEnabled: (pluginId, enabled) =>
        Promise.resolve(
          pluginId === "active-memory"
            ? committed(pluginId, enabled, ["Review active-memory settings."])
            : committed(pluginId, enabled),
        ),
    });
    mountMemoryPage(element);
    const mutate = (owner: Exclude<typeof first | typeof second, "reconnect">) => {
      if (owner === "engine") {
        selectEngine(element, "other");
        return;
      }
      toggleAddon(
        element,
        owner === "active-memory" ? "Active memory" : "Memory wiki",
        owner === "memory-wiki",
      );
    };
    try {
      await waitForSolid(() => expect(activeEngine(element)).toBe("memory-core"));
      await waitForAddon(element);
      mutate(first);
      await waitForSolid(() =>
        expect(element.textContent).toContain("previous authoritative refresh failed"),
      );
      if (first === "engine") {
        expect(element.textContent).toContain("Needs attention");
        expect(element.textContent).not.toContain("Could not change the memory engine");
      }

      if (second === "reconnect") {
        setPhase("disconnected");
        setPhase("connected");
      } else {
        mutate(second);
        await waitForSolid(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));
      }
      await waitForSolid(() =>
        expect(element.textContent).not.toContain("previous authoritative refresh failed"),
      );
      if (first === "active-memory") {
        expect(element.textContent).toContain("Review active-memory settings.");
      }
    } finally {
      await finishMemory(element, runExternalMutation);
    }
  },
);
