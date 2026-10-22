/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  validateConfigPatchParams,
  type ConfigPatchParams,
  type EnvironmentsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { applyMergePatch } from "../../../../src/config/merge-patch.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { button as actionButton } from "./cloud-worker-snapshots-dom.test-support.ts";
import { CloudWorkersPage } from "./cloud-workers-page.tsx";
import {
  change,
  click,
  configSnapshot,
  machineProfile,
  waitText,
} from "./cloud-workers.test-support.ts";

// mock-isolation: Replace the imperative dialog so confirmations remain deterministic.
vi.mock("../../components/confirm-dialog.ts", () => ({ showConfirmDialog: vi.fn() }));

beforeEach(async () => {
  await i18n.setLocale("en");
  vi.mocked(showConfirmDialog).mockReset().mockResolvedValue(true);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function mountProfiles(client: GatewayBrowserClient) {
  const gatewayHarness = createGatewayHarness(client);
  gatewayHarness.publish(
    true,
    client,
    gatewayHelloForMethods(["config.patch", "environments.list"]),
  );
  const gateway = Object.assign(gatewayHarness.gateway, {
    connection: { gatewayUrl: "ws://gateway.example.test", token: "", password: "" },
  });
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  const context = {
    gateway,
    runtimeConfig,
    router: { subscribe: () => () => {} },
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  const view = mountSolid(() => (
    <ApplicationProvider value={context}>
      <CloudWorkersPage />
    </ApplicationProvider>
  ));
  return {
    gatewayHarness,
    runtimeConfig,
    view,
    page: expectDefined(
      view.container.querySelector("openclaw-cloud-workers-page"),
      "Cloud workers page",
    ),
  };
}

function profileRow(page: Element, id: string) {
  return expectDefined(
    [...page.querySelectorAll(".settings-row")].find(
      (row) => row.querySelector("code")?.textContent === id,
    ),
    id,
  );
}

const operatingSystems = [
  { id: "linux", label: "Linux", default: true },
  { id: "macos", label: "macOS" },
  { id: "windows/wsl2", label: "Windows (WSL2)" },
  { id: "future-os", label: "Future OS", disabledReason: "Upgrade the worker provider." },
];

function osSelect(page: Element) {
  return page.querySelector<HTMLSelectElement>('select[aria-label="Operating system"]');
}

it("keeps the profile draft and accepted catalog through refresh failure and retry", async () => {
  const config = { cloudWorkers: { profiles: { worker: machineProfile() } } };
  const catalog = {
    environments: [],
    profiles: [{ id: "worker", providerId: "crabbox", operatingSystems }],
  };
  let hash = "initial";
  let response = Promise.resolve<EnvironmentsListResult>(catalog);
  const request = createGatewayRequestMock(async (method, params) => {
    if (method === "config.get") {
      return configSnapshot(config, hash);
    }
    if (method === "environments.list") {
      return isRecord(params) && params.projection === "profiles" ? response : { environments: [] };
    }
    throw new Error(`Unexpected request ${method}`);
  });
  const client = createTestGatewayClient(request);
  const transport = vi.spyOn(client, "request");
  const { runtimeConfig, view, page } = mountProfiles(client);
  const catalogCalls = () =>
    transport.mock.calls.filter(
      ([method, params]) =>
        method === "environments.list" && isRecord(params) && params.projection === "profiles",
    ).length;
  try {
    await waitForSolid(() =>
      expect(profileRow(page, "worker").textContent).toContain("Advertised"),
    );
    click(profileRow(page, "worker"), "Edit");
    const lifetime = await waitForSolid(() =>
      expectDefined(
        page.querySelector<HTMLInputElement>('input[aria-label="Max lifetime"]'),
        "Profile lifetime",
      ),
    );
    change(lifetime, "9h");
    const refresh = async (nextHash: string) => {
      const pending = createDeferred<EnvironmentsListResult>();
      response = pending.promise;
      hash = nextHash;
      const before = catalogCalls();
      await runtimeConfig.refresh();
      await waitForSolid(() => expect(catalogCalls()).toBeGreaterThan(before));
      return pending;
    };
    const pending = await refresh("second");
    expect(profileRow(page, "worker").textContent).toContain("Advertised");
    expect(page.querySelector('input[aria-label="Max lifetime"]')).toBe(lifetime);
    expect(lifetime.value).toBe("9h");
    pending.reject(new Error("Synthetic catalog unavailable"));
    await waitText(() => page, "Synthetic catalog unavailable");
    expect(page.querySelector('input[aria-label="Max lifetime"]')).toBe(lifetime);
    expect(lifetime.value).toBe("9h");

    const retry = await refresh("third");
    expect(page.textContent).toContain("Synthetic catalog unavailable");
    retry.resolve(catalog);
    await waitForSolid(() =>
      expect(page.textContent).not.toContain("Synthetic catalog unavailable"),
    );
    expect(profileRow(page, "worker").textContent).toContain("Advertised");
    expect(page.querySelector('input[aria-label="Max lifetime"]')).toBe(lifetime);
    expect(lifetime.value).toBe("9h");
  } finally {
    view.unmount();
    runtimeConfig.dispose();
  }
});

it("retires a pending profile catalog when permissions change on the same connection", async () => {
  const pendingCatalog = createDeferred<EnvironmentsListResult>();
  const config = { cloudWorkers: { profiles: { worker: machineProfile() } } };
  const request = createGatewayRequestMock(async (method, params) => {
    if (method === "config.get") {
      return configSnapshot(config, "initial");
    }
    if (method === "environments.list") {
      return isRecord(params) && params.projection === "profiles"
        ? pendingCatalog.promise
        : { environments: [] };
    }
    throw new Error(`Unexpected request ${method}`);
  });
  const client = createTestGatewayClient(request);
  const transport = vi.spyOn(client, "request");
  const { gatewayHarness: source, runtimeConfig, view } = mountProfiles(client);
  try {
    await waitForSolid(() => expect(view.getByText("worker", { selector: "code" })).toBeTruthy());
    const { catalogSignal, catalogCompletion } = await waitForSolid(() => {
      const candidateIndex = transport.mock.calls.findLastIndex(
        ([method, params]) =>
          method === "environments.list" && isRecord(params) && params.projection === "profiles",
      );
      const call = expectDefined(transport.mock.calls[candidateIndex], "Profile catalog request");
      const signal = expectDefined(call[2]?.signal, "Profile catalog cancellation signal");
      expect(signal.aborted).toBe(false);
      return {
        catalogSignal: signal,
        catalogCompletion: expectDefined(
          transport.mock.results[candidateIndex],
          "Profile catalog result",
        ).value,
      };
    });

    source.publish(true, client, gatewayHelloForMethods([]));
    expect(catalogSignal.aborted).toBe(true);
    await waitForSolid(() => expect(view.getByText("Unavailable")).toBeTruthy());
    pendingCatalog.resolve({
      environments: [],
      profiles: [{ id: "worker", providerId: "crabbox" }],
    });
    await catalogCompletion;
    flush();

    expect(view.queryByText("Advertised")).toBeNull();
    expect(view.getByText("Unavailable")).toBeTruthy();
  } finally {
    view.unmount();
    runtimeConfig.dispose();
  }
});

it.each([
  ["delete", undefined, undefined, operatingSystems],
  ["setup-clear", undefined, undefined, operatingSystems.slice(0, 1)],
  ["setup-clear", "linux", "linux", operatingSystems.slice(0, 1)],
  ["setup-clear", undefined, "macos", operatingSystems],
  ["setup-clear", "linux", "windows/wsl2", operatingSystems],
  ["setup-clear", "windows/wsl2", "", operatingSystems.slice(0, 1)],
  ["setup-clear", "retired-os", "", []],
] as const)(
  "forwards %s array intent and saves OS %s → %s without losing unrelated data",
  async (action, initialTarget, target, systems) => {
    const renderingErrors = vi.spyOn(console, "error");
    const settings = {
      provider: "aws",
      class: "standard",
      ttl: "8h",
      idleTimeout: "45m",
      ...(initialTarget ? { target: initialTarget } : {}),
    };
    const retained = { provider: "crabbox", settings: { ...settings, opaque: null } };
    const pending = {
      provider: "crabbox",
      settings: { ...settings, setup: "true", setupEnv: ["QA_WORKER_FLAG"], opaque: null },
    };
    const projectProfiles = {
      "github.com/acme/pending": "pending",
      "github.com/acme/retained": "retained",
    };
    let config: Record<string, unknown> = {
      cloudWorkers: { profiles: { pending, retained }, projectProfiles },
    };
    let hash = "before";
    const patches: ConfigPatchParams[] = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "config.get") {
        return configSnapshot(config, hash);
      }
      if (method === "environments.list") {
        if (!isRecord(params) || params.projection !== "profiles") {
          return { environments: [] };
        }
        return {
          environments: [],
          profiles: [
            { id: "pending", operatingSystems: systems },
            ...(hash === "after" ? [{ id: "retained" }] : []),
          ],
        };
      }
      if (method !== "config.patch" || !validateConfigPatchParams(params)) {
        throw new Error(`Unexpected request ${method}`);
      }
      patches.push(params);
      const merged = applyMergePatch(config, JSON.parse(params.raw), {
        mergeObjectArraysById: true,
      });
      if (!isRecord(merged)) {
        throw new Error("Expected a merged configuration object");
      }
      config = merged;
      hash = "after";
      return { ok: true, config, hash };
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gatewayHarness, runtimeConfig, view, page } = mountProfiles(client);
    try {
      await waitForSolid(() => {
        const profiles = [...page.querySelectorAll(".settings-section")].find((section) =>
          section.querySelector("h2")?.textContent?.trim().startsWith("Machines"),
        );
        expect(profiles?.querySelectorAll(".settings-row code")).toHaveLength(2);
      });
      const row = profileRow(page, "pending");
      if (action === "delete") {
        await waitForSolid(() => expect(actionButton(row, "Delete").disabled).toBe(false));
        click(row, "Delete");
      } else {
        click(row, "Edit");
        await waitForSolid(() => expect(page.querySelector("textarea")).not.toBeNull());
        const operatingSystem = osSelect(page);
        if (
          systems.length < 2 &&
          (!initialTarget || systems.some((system) => system.id === initialTarget))
        ) {
          expect(operatingSystem).toBeNull();
        } else {
          const select = expectDefined(operatingSystem, "Operating system editor");
          expect(select.value).toBe(initialTarget ?? "");
          expect([...select.options].map((option) => option.value)).toEqual([
            "",
            ...systems.map((system) => system.id),
            ...(initialTarget && !systems.some((system) => system.id === initialTarget)
              ? [initialTarget]
              : []),
          ]);
          for (const system of systems) {
            if (system.disabledReason) {
              const option = expectDefined(
                [...select.options].find((candidate) => candidate.value === system.id),
                "Unavailable operating system",
              );
              expect(option).toMatchObject({
                disabled: true,
                textContent: expect.stringContaining(system.disabledReason),
              });
            }
          }
          change(select, expectDefined(target, "Selected OS"));
        }
        change(
          expectDefined(page.querySelector<HTMLTextAreaElement>("textarea"), "Setup command"),
          "",
        );
        await waitForSolid(() => expect(actionButton(page, "Save").disabled).toBe(false));
        click(page, "Save");
        await waitText(() => page, "Enter a setup command or clear the setup environment names.");
        expect(patches).toHaveLength(0);
        const setupEnv = expectDefined(
          page.querySelector<HTMLInputElement>('input[aria-label="Setup environment names"]'),
          "Setup environment names",
        );
        expect(setupEnv.value).toBe("QA_WORKER_FLAG");
        change(setupEnv, "");
        await waitForSolid(() => expect(actionButton(page, "Save").disabled).toBe(false));
        click(page, "Save");
      }
      await waitForSolid(() => expect(patches).toHaveLength(1));
      await runtimeConfig.refresh();
      flush();
      await waitForSolid(() => {
        const retainedRow = profileRow(page, "retained");
        expect(retainedRow?.textContent).toContain("Advertised");
      });
      if (action !== "delete") {
        await waitText(() => page, "Profile saved.");
        expect(request).not.toHaveBeenCalledWith("environments.prepare", expect.anything());
      }
      expect(patches[0]).toMatchObject({
        baseHash: "before",
        replacePaths: ["cloudWorkers.profiles.pending.settings.setupEnv"],
      });
      const raw = JSON.parse(expectDefined(patches[0], "mutation request").raw);
      expect(Object.keys(raw.cloudWorkers.profiles)).toEqual(["pending"]);
      const { target: _initialTarget, ...settingsWithoutTarget } = settings;
      const savedProfile = {
        provider: "crabbox",
        install: "bundle",
        settings: { ...settingsWithoutTarget, ...(target ? { target } : {}), opaque: null },
      };
      expect(config).toEqual({
        cloudWorkers: {
          profiles: action === "delete" ? { retained } : { pending: savedProfile, retained },
          projectProfiles:
            action === "delete" ? { "github.com/acme/retained": "retained" } : projectProfiles,
        },
      });
      if (action !== "delete") {
        await waitForSolid(() => expect(page.querySelector("textarea")).toBeNull());
        const savedRow = profileRow(page, "pending");
        if (target && target !== "linux") {
          expect(savedRow.textContent).toContain(
            `Operating system: ${systems.find((system) => system.id === target)?.label ?? target}`,
          );
        } else {
          expect(savedRow.textContent).not.toContain("Operating system:");
        }
        click(savedRow, "Edit");
        await waitForSolid(() => expect(page.querySelector("textarea")).not.toBeNull());
        const savedSelect = osSelect(page);
        if (systems.length >= 2) {
          expect(savedSelect?.value).toBe(target || "");
        } else {
          expect(savedSelect).toBeNull();
        }
        click(page, "Cancel");
        click(page, "Add profile");
        await waitForSolid(() =>
          expect(page.querySelector('input[aria-label="Profile ID"]')).not.toBeNull(),
        );
        expect(osSelect(page)).toBeNull();
      } else {
        gatewayHarness.publish(false);
        flush();
        const deleteButton = await waitForSolid(() => {
          const retainedRow = profileRow(page, "retained");
          expect(retainedRow?.textContent).toContain("Advertised");
          expect(retainedRow?.textContent).not.toContain("Unavailable");
          const button = actionButton(retainedRow, "Delete");
          expect(button.disabled).toBe(true);
          return button;
        });
        deleteButton.click();
        expect(patches).toHaveLength(1);
      }
    } finally {
      view.unmount();
      runtimeConfig.dispose();
    }
    expect(renderingErrors).not.toHaveBeenCalled();
  },
);

it("keeps a rejected profile draft and retires pending save presentation on access loss", async () => {
  const config = { cloudWorkers: { profiles: { worker: machineProfile() } } };
  let pending = createDeferred<unknown>();
  let patches = 0;
  const request = createGatewayRequestMock(async (method) => {
    if (method === "config.get") {
      return configSnapshot(config, "initial");
    }
    if (method === "environments.list") {
      return { environments: [], profiles: [] };
    }
    if (method === "config.patch") {
      patches += 1;
      return pending.promise;
    }
    throw new Error(`Unexpected request ${method}`);
  });
  const client = createTestGatewayClient(request);
  const { gatewayHarness, runtimeConfig, view, page } = mountProfiles(client);
  try {
    await waitForSolid(() => expect(profileRow(page, "worker")).toBeTruthy());
    click(profileRow(page, "worker"), "Edit");
    const lifetime = await waitForSolid(() =>
      expectDefined(
        page.querySelector<HTMLInputElement>('input[aria-label="Max lifetime"]'),
        "Profile lifetime",
      ),
    );
    change(lifetime, "9h");
    click(page, "Save");
    await waitForSolid(() => {
      expect(patches).toBe(1);
      expect(actionButton(page, "Saving…").disabled).toBe(true);
      expect(lifetime.disabled).toBe(true);
    });
    pending.reject(new Error("Synthetic profile save unavailable"));
    await waitText(() => page, "Synthetic profile save unavailable");
    expect(page.querySelector('input[aria-label="Max lifetime"]')).toBe(lifetime);
    expect(lifetime.value).toBe("9h");
    await waitForSolid(() => expect(actionButton(page, "Save").disabled).toBe(false));

    pending = createDeferred<unknown>();
    click(page, "Save");
    await waitForSolid(() => expect(patches).toBe(2));
    gatewayHarness.publish(true, client, gatewayHelloForMethods([], ["operator.read"]));
    await waitText(() => page, "Administrator access is required to manage cloud worker profiles.");
    expect(page.querySelector('input[aria-label="Max lifetime"]')).toBeNull();
    pending.resolve({ ok: true, config, hash: "after" });
    await pending.promise;
    flush();
    expect(page.querySelector('input[aria-label="Max lifetime"]')).toBeNull();
    expect(page.textContent).not.toContain("Profile saved.");
  } finally {
    view.unmount();
    runtimeConfig.dispose();
  }
});
