/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { setPluginEnabled } from "../../lib/plugins/index.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  activeEngine,
  addonSwitch,
  createMemoryPage,
  createMemoryTestAddon,
  createMemoryTestDeferred,
  createMemoryTestEngine,
  createMemoryTestMutationResult as committed,
  selectEngine,
  toggleAddon,
} from "./memory-page.test-support.ts";
import "./memory-page.ts";

vi.mock("../../lib/plugins/index.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/plugins/index.ts")>();
  return { ...actual, setPluginEnabled: vi.fn() };
});

describe("Memory plugin mutation ownership", () => {
  beforeEach(() => vi.mocked(setPluginEnabled).mockReset());

  it("keeps a committed engine successful while making its failed refresh visible", async () => {
    const { element, runExternalMutation } = createMemoryPage({
      configObject: {},
      catalog: [
        createMemoryTestEngine("memory-core", true),
        createMemoryTestEngine("other", false),
      ],
      refresh: () => Promise.reject(new Error("authoritative snapshot unavailable")),
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(activeEngine(element)).toBe("memory-core"));
      selectEngine(element, "other");

      await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledOnce());
      await waitForFast(() =>
        expect(element.textContent).toContain(
          "Could not refresh Control UI configuration: authoritative snapshot unavailable",
        ),
      );
      expect(element.textContent).toContain("Needs attention");
      expect(element.textContent).not.toContain("Could not change the memory engine");
    } finally {
      element.remove();
    }
  });

  it("serializes sibling add-on writes through the shared configuration owner", async () => {
    const firstMutation = createMemoryTestDeferred<unknown>();
    const setEnabled = vi.fn((pluginId: string) =>
      pluginId === "active-memory"
        ? firstMutation.promise
        : Promise.resolve(committed(pluginId, true)),
    );
    const { element, runExternalMutation } = createMemoryPage({
      configObject: {},
      catalog: [
        createMemoryTestAddon("active-memory", true),
        createMemoryTestAddon("memory-wiki", false),
      ],
      setEnabled,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
      toggleAddon(element, "Active memory", false);
      toggleAddon(element, "Memory wiki", true);

      await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));
      await waitForFast(() => expect(setEnabled).toHaveBeenCalledOnce());
      expect(setEnabled).toHaveBeenCalledWith("active-memory", false);

      firstMutation.resolve(committed("active-memory", false));
      await waitForFast(() => expect(setEnabled).toHaveBeenCalledWith("memory-wiki", true));
    } finally {
      firstMutation.resolve(committed("active-memory", false));
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it.each(["reconnect", "boot", "admin scope", "read-only catalog"])(
    "drops an add-on mutation queued before a %s change",
    async (change) => {
      const pendingWrites = createMemoryTestDeferred<void>();
      const setEnabled = vi.fn((pluginId: string, enabled: boolean) =>
        Promise.resolve(committed(pluginId, enabled)),
      );
      let mutationAllowed = true;
      const {
        element,
        runExternalMutation,
        setPhase,
        setBootId,
        setScopes,
        publishPluginGeneration,
      } = createMemoryPage({
        configObject: {},
        listCatalog: () =>
          Promise.resolve({
            plugins: [createMemoryTestAddon("active-memory", true)],
            mutationAllowed,
          }),
        waitForPendingWrites: () => pendingWrites.promise,
        setEnabled,
      });
      document.body.append(element);
      try {
        await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
        toggleAddon(element, "Active memory", false);
        await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledOnce());

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
          await waitForFast(() => expect(addonSwitch(element, "Active memory")).toBeNull());
        }
        pendingWrites.resolve();
        await runExternalMutation.mock.results[0]?.value;

        expect(setEnabled).not.toHaveBeenCalled();
        if (change === "reconnect" || change === "boot") {
          expect(element.textContent).not.toContain("Could not update Active memory");
        }
      } finally {
        pendingWrites.resolve();
        await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
        element.remove();
      }
    },
  );

  it.each(["queued", "in flight"])(
    "preserves a %s add-on mutation and its busy state across plugin publications",
    async (phase) => {
      const pendingWrites = createMemoryTestDeferred<void>();
      const reply = createMemoryTestDeferred<unknown>();
      const setEnabled = vi.fn(() => reply.promise);
      const { element, runExternalMutation, publishPluginGeneration } = createMemoryPage({
        configObject: {},
        catalog: [createMemoryTestAddon("active-memory", true)],
        waitForPendingWrites: () => pendingWrites.promise,
        setEnabled,
      });
      document.body.append(element);
      try {
        await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
        toggleAddon(element, "Active memory", false);
        await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledOnce());
        if (phase === "in flight") {
          pendingWrites.resolve();
          await waitForFast(() => expect(setEnabled).toHaveBeenCalledOnce());
        }
        publishPluginGeneration(1);
        publishPluginGeneration(1);
        await waitForFast(() =>
          expect(addonSwitch(element, "Active memory")?.hasAttribute("disabled")).toBe(true),
        );
        expect(setEnabled).toHaveBeenCalledTimes(phase === "queued" ? 0 : 1);
        pendingWrites.resolve();
        await waitForFast(() => expect(setEnabled).toHaveBeenCalledOnce());
        reply.resolve(committed("active-memory", false, ["Review active-memory settings."]));
        await waitForFast(() =>
          expect(element.textContent).toContain("Review active-memory settings."),
        );
        await waitForFast(() =>
          expect(addonSwitch(element, "Active memory")?.hasAttribute("disabled")).toBe(false),
        );
        expect(runExternalMutation).toHaveBeenCalledOnce();
      } finally {
        pendingWrites.resolve();
        reply.resolve(committed("active-memory", false));
        await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
        element.remove();
      }
    },
  );

  it("keeps each sibling's runtime warning after queued mutations", async () => {
    const firstMutation = createMemoryTestDeferred<unknown>();
    const { element, runExternalMutation } = createMemoryPage({
      configObject: {},
      catalog: [
        createMemoryTestAddon("active-memory", true),
        createMemoryTestAddon("memory-wiki", false),
      ],
      setEnabled: (pluginId, enabled) =>
        pluginId === "active-memory"
          ? firstMutation.promise
          : Promise.resolve(committed(pluginId, enabled, ["Review memory-wiki settings."])),
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
      toggleAddon(element, "Active memory", false);
      toggleAddon(element, "Memory wiki", true);
      await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));
      firstMutation.resolve(committed("active-memory", false, ["Review active-memory settings."]));
      await waitForFast(() => {
        expect(element.textContent).toContain("Review active-memory settings.");
        expect(element.textContent).toContain("Review memory-wiki settings.");
      });
    } finally {
      firstMutation.resolve(committed("active-memory", false));
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it("shows a committed runtime warning without waiting for process discovery", async () => {
    const processInfo = createMemoryTestDeferred<{ processInstanceId: string }>();
    const { element, request, runExternalMutation } = createMemoryPage({
      configObject: {},
      catalog: [createMemoryTestAddon("active-memory", true)],
      processInfo: () => processInfo.promise,
      setEnabled: (pluginId, enabled) =>
        Promise.resolve({
          ok: true,
          restartRequired: false,
          plugin: createMemoryTestAddon(pluginId, enabled),
          runtime: { operationId: "completed-toggle", generation: 1, pluginIds: [pluginId] },
          warnings: ["Review the addon settings."],
        }),
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
      toggleAddon(element, "Active memory", false);
      await waitForFast(() => expect(element.textContent).toContain("Review the addon settings."));
      expect(request.mock.calls.filter(([method]) => method === "system.info")).toHaveLength(0);
    } finally {
      processInfo.resolve({ processInstanceId: "memory-process" });
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it("keeps the replacement add-on busy after an older connection finishes", async () => {
    const firstMutation = createMemoryTestDeferred<unknown>();
    const secondMutation = createMemoryTestDeferred<unknown>();
    let mutationCalls = 0;
    const setEnabled = vi.fn(() =>
      mutationCalls++ === 0 ? firstMutation.promise : secondMutation.promise,
    );
    const { element, request, runExternalMutation, setPhase } = createMemoryPage({
      configObject: {},
      catalog: [createMemoryTestAddon("active-memory", true)],
      setEnabled,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
      toggleAddon(element, "Active memory", false);
      await waitForFast(() => expect(setEnabled).toHaveBeenCalledOnce());

      setPhase("disconnected");
      setPhase("connected");
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(2),
      );
      await waitForFast(async () => {
        await element.updateComplete;
        expect(addonSwitch(element, "Active memory")).not.toBeNull();
      });
      toggleAddon(element, "Active memory", false);
      await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));

      firstMutation.resolve(committed("active-memory", false));
      await waitForFast(() => expect(setEnabled).toHaveBeenCalledTimes(2));
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(3),
      );
      await element.updateComplete;
      expect(addonSwitch(element, "Active memory")?.hasAttribute("disabled")).toBe(true);

      secondMutation.resolve(committed("active-memory", false));
      await waitForFast(() =>
        expect(addonSwitch(element, "Active memory")?.hasAttribute("disabled")).toBe(false),
      );
    } finally {
      firstMutation.resolve(committed("active-memory", false));
      secondMutation.resolve(committed("active-memory", false));
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it("keeps the replacement engine busy after an older connection finishes", async () => {
    const firstMutation = createMemoryTestDeferred<unknown>();
    const secondMutation = createMemoryTestDeferred<unknown>();
    let mutationCalls = 0;
    const setEnabled = vi.fn(() =>
      mutationCalls++ === 0 ? firstMutation.promise : secondMutation.promise,
    );
    const { element, request, runExternalMutation, setPhase } = createMemoryPage({
      configObject: {},
      catalog: [
        createMemoryTestEngine("memory-core", true),
        createMemoryTestEngine("other", false),
      ],
      setEnabled,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(activeEngine(element)).toBe("memory-core"));
      selectEngine(element, "other");
      await waitForFast(() => expect(setEnabled).toHaveBeenCalledOnce());

      setPhase("disconnected");
      setPhase("connected");
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(2),
      );
      await waitForFast(async () => {
        await element.updateComplete;
        expect(activeEngine(element)).toBe("memory-core");
      });
      selectEngine(element, "other");
      await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));

      firstMutation.resolve(committed("other", true));
      await waitForFast(() => expect(setEnabled).toHaveBeenCalledTimes(2));
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(3),
      );
      await element.updateComplete;
      expect(
        element.querySelector<HTMLElement & { disabled?: boolean }>(
          "wa-radio-group.settings-segmented",
        )?.disabled,
      ).toBe(true);

      secondMutation.resolve(committed("other", true));
      await waitForFast(() =>
        expect(
          element.querySelector<HTMLElement & { disabled?: boolean }>(
            "wa-radio-group.settings-segmented",
          )?.disabled,
        ).toBe(false),
      );
    } finally {
      firstMutation.resolve(committed("other", true));
      secondMutation.resolve(committed("other", true));
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it("clears a runtime warning after a newer successful mutation of the same add-on", async () => {
    let enabled = true;
    let attempts = 0;
    const { element, runExternalMutation } = createMemoryPage({
      configObject: {},
      listCatalog: () =>
        Promise.resolve({ plugins: [createMemoryTestAddon("active-memory", enabled)] }),
      setEnabled: (pluginId, nextEnabled) => {
        enabled = nextEnabled;
        return Promise.resolve(
          committed(pluginId, enabled, attempts++ === 0 ? ["Earlier runtime warning."] : []),
        );
      },
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));
      toggleAddon(element, "Active memory", false);
      await waitForFast(() => expect(element.textContent).toContain("Earlier runtime warning."));
      await waitForFast(() =>
        expect(addonSwitch(element, "Active memory")?.hasAttribute("disabled")).toBe(false),
      );
      toggleAddon(element, "Active memory", true);
      await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));
      await waitForFast(() =>
        expect(element.textContent).not.toContain("Earlier runtime warning."),
      );
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));
    } finally {
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it.each(["memory-boot-b", undefined])(
    "does not insert an old runtime warning after the boot ID changes to %s",
    async (bootId) => {
      const reply = createMemoryTestDeferred<unknown>();
      const setEnabled = vi.fn(() => reply.promise);
      const { element, request, runExternalMutation, setBootId } = createMemoryPage({
        configObject: {},
        catalog: [createMemoryTestAddon("active-memory", true)],
        setEnabled,
      });
      document.body.append(element);
      try {
        await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
        toggleAddon(element, "Active memory", false);
        await waitForFast(() => expect(setEnabled).toHaveBeenCalledOnce());
        setBootId(bootId);
        await waitForFast(() =>
          expect(addonSwitch(element, "Active memory")?.hasAttribute("disabled")).toBe(false),
        );
        reply.resolve(committed("active-memory", false, ["Old boot runtime warning."]));
        await runExternalMutation.mock.results[0]?.value;
        await waitForFast(() =>
          expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(
            3,
          ),
        );
        await element.updateComplete;
        expect(element.textContent).not.toContain("Old boot runtime warning.");
        expect(element.textContent).not.toContain("Could not update Active memory");
      } finally {
        reply.resolve(committed("active-memory", false));
        await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
        element.remove();
      }
    },
  );

  it("clears a rendered refresh warning after reconnect without losing its runtime warning", async () => {
    let failRefresh = true;
    let enabled = true;
    const { element, runExternalMutation, setPhase } = createMemoryPage({
      configObject: {},
      listCatalog: () =>
        Promise.resolve({ plugins: [createMemoryTestAddon("active-memory", enabled)] }),
      refresh: () =>
        failRefresh
          ? Promise.reject(new Error("old authoritative refresh failed"))
          : Promise.resolve(),
      setEnabled: (pluginId, nextEnabled) => {
        enabled = nextEnabled;
        return Promise.resolve(
          committed(pluginId, nextEnabled, ["Review active-memory settings."]),
        );
      },
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(addonSwitch(element, "Active memory")?.checked).toBe(true));
      toggleAddon(element, "Active memory", false);
      await waitForFast(() => {
        expect(element.textContent).toContain("old authoritative refresh failed");
        expect(element.textContent).toContain("Review active-memory settings.");
      });

      failRefresh = false;
      setPhase("disconnected");
      setPhase("connected");
      await waitForFast(() => {
        expect(element.textContent).not.toContain("old authoritative refresh failed");
        expect(element.textContent).toContain("Review active-memory settings.");
      });
    } finally {
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });

  it.each([
    ["active-memory", "memory-wiki"],
    ["engine", "active-memory"],
    ["active-memory", "engine"],
  ] as const)(
    "clears a %s refresh warning when %s refreshes authoritative configuration",
    async (first, second) => {
      let refreshCalls = 0;
      const { element, runExternalMutation } = createMemoryPage({
        configObject: {},
        catalog: [
          createMemoryTestEngine("memory-core", true),
          createMemoryTestEngine("other", false),
          createMemoryTestAddon("active-memory", true),
          createMemoryTestAddon("memory-wiki", false),
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
      document.body.append(element);
      const mutate = (owner: typeof first | typeof second) => {
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
        await waitForFast(() => expect(activeEngine(element)).toBe("memory-core"));
        await waitForFast(() => expect(addonSwitch(element, "Active memory")).not.toBeNull());
        mutate(first);
        await waitForFast(() =>
          expect(element.textContent).toContain("previous authoritative refresh failed"),
        );

        mutate(second);
        await waitForFast(() => expect(runExternalMutation).toHaveBeenCalledTimes(2));
        await waitForFast(() =>
          expect(element.textContent).not.toContain("previous authoritative refresh failed"),
        );
        if (first === "active-memory") {
          expect(element.textContent).toContain("Review active-memory settings.");
        }
      } finally {
        await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
        element.remove();
      }
    },
  );

  it("reloads the replacement connection after an older engine change commits", async () => {
    const pendingMutation = createMemoryTestDeferred<unknown>();
    const { element, request, runExternalMutation, setPhase } = createMemoryPage({
      configObject: {},
      listCatalog: (call) =>
        Promise.resolve({
          plugins:
            call < 2
              ? [
                  createMemoryTestEngine("memory-core", true),
                  createMemoryTestEngine("other", false),
                ]
              : [
                  createMemoryTestEngine("memory-core", false),
                  createMemoryTestEngine("other", true),
                ],
        }),
      setEnabled: () => pendingMutation.promise,
    });
    document.body.append(element);
    try {
      await waitForFast(() => expect(activeEngine(element)).toBe("memory-core"));
      selectEngine(element, "other");
      await waitForFast(() => expect(setPluginEnabled).toHaveBeenCalledOnce());

      setPhase("disconnected");
      setPhase("connected");
      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(2),
      );
      pendingMutation.resolve(committed("other", true));

      await waitForFast(() =>
        expect(request.mock.calls.filter(([method]) => method === "plugins.list")).toHaveLength(3),
      );
      expect(element.textContent).not.toContain("Could not change the memory engine");
    } finally {
      pendingMutation.resolve(committed("other", true));
      await Promise.allSettled(runExternalMutation.mock.results.map(({ value }) => value));
      element.remove();
    }
  });
});
