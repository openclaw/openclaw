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
  for (const dispose of disposers.splice(0).toReversed()) {
    dispose();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const disposers: Array<() => void> = [];
const workerConfig = { cloudWorkers: { profiles: { worker: machineProfile() } } };
const isCatalog = (method: string, params: unknown) =>
  method === "environments.list" && isRecord(params) && params.projection === "profiles";
const field = (page: Element, label: string) =>
  page.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
const lifetimeField = (page: Element) => field(page, "Max lifetime");
const waitEnabled = (page: Element, label: string) =>
  waitForSolid(() => expect(actionButton(page, label).disabled).toBe(false));

function mountProfiles(client: GatewayBrowserClient) {
  const gatewayHarness = createGatewayHarness(client);
  gatewayHarness.publish(
    true,
    client,
    gatewayHelloForMethods(["config.patch", "environments.list"]),
  );
  const gateway = gatewayHarness.gateway;
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
  disposers.push(() => {
    view.unmount();
    runtimeConfig.dispose();
  });
  return {
    gatewayHarness,
    runtimeConfig,
    page: expectDefined(
      view.container.querySelector("openclaw-cloud-workers-page"),
      "Cloud workers page",
    ),
  };
}

function expectDraft(page: Element, input: HTMLInputElement) {
  expect(lifetimeField(page)).toBe(input);
  expect(input.value).toBe("9h");
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

it("keeps profile drafts through catalog and save failures, then retires them on access loss", async () => {
  const catalog = {
    environments: [],
    profiles: [{ id: "worker", providerId: "crabbox", operatingSystems }],
  };
  let hash = "initial";
  let pendingSave = createDeferred<unknown>();
  let patches = 0;
  let response = Promise.resolve<EnvironmentsListResult>(catalog);
  const transport = createGatewayRequestMock(async (method, params) => {
    if (method === "config.get") {
      return configSnapshot(workerConfig, hash);
    }
    if (method === "environments.list") {
      return isCatalog(method, params) ? response : { environments: [] };
    }
    if (method === "config.patch") {
      patches++;
      return pendingSave.promise;
    }
    throw new Error(`Unexpected request ${method}`);
  });
  const client = createTestGatewayClient(transport);
  const { runtimeConfig, page, gatewayHarness } = mountProfiles(client);
  const catalogCalls = () =>
    transport.mock.calls.filter(([method, params]) => isCatalog(method, params)).length;
  await waitForSolid(() => expect(profileRow(page, "worker").textContent).toContain("Advertised"));
  click(profileRow(page, "worker"), "Edit");
  const lifetime = await waitForSolid(() => expectDefined(lifetimeField(page), "Profile lifetime"));
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
  expectDraft(page, lifetime);
  pending.reject(new Error("Synthetic catalog unavailable"));
  await waitText(() => page, "Synthetic catalog unavailable");
  expectDraft(page, lifetime);

  const retry = await refresh("third");
  expect(page.textContent).toContain("Synthetic catalog unavailable");
  retry.resolve(catalog);
  await waitForSolid(() => expect(page.textContent).not.toContain("Synthetic catalog unavailable"));
  expect(profileRow(page, "worker").textContent).toContain("Advertised");
  expectDraft(page, lifetime);
  click(page, "Save");
  await waitForSolid(() => {
    expect(patches).toBe(1);
    expect(actionButton(page, "Saving…").disabled).toBe(true);
    expect(lifetime.disabled).toBe(true);
    expect(page.querySelector<HTMLInputElement>(".settings-toggle__input")?.disabled).toBe(true);
  });
  pendingSave.reject(new Error("Synthetic profile save unavailable"));
  await waitText(() => page, "Synthetic profile save unavailable");
  expectDraft(page, lifetime);
  await waitEnabled(page, "Save");
  expect(page.querySelector<HTMLInputElement>(".settings-toggle__input")?.disabled).toBe(false);

  pendingSave = createDeferred<unknown>();
  click(page, "Save");
  await waitForSolid(() => expect(patches).toBe(2));
  gatewayHarness.publish(true, client, gatewayHelloForMethods([], ["operator.read"]));
  await waitText(() => page, "Administrator access is required to manage cloud worker profiles.");
  expect(lifetimeField(page)).toBeNull();
  pendingSave.resolve({ ok: true, config: workerConfig, hash: "after" });
  await pendingSave.promise;
  flush();
  expect(lifetimeField(page)).toBeNull();
  expect(page.textContent).not.toContain("Profile saved.");
});

it.each([
  [undefined, undefined, operatingSystems.slice(0, 1)],
  ["linux", "linux", operatingSystems.slice(0, 1)],
  [undefined, "macos", operatingSystems],
  ["linux", "windows/wsl2", operatingSystems],
  ["windows/wsl2", "", operatingSystems.slice(0, 1)],
  ["retired-os", "", []],
] as const)("saves OS %s → %s and clears setup fields", async (initialTarget, target, systems) => {
  const opaque = { nullable: null, flags: ["kept"] };
  let config: Record<string, unknown> = {
    cloudWorkers: {
      profiles: {
        worker: machineProfile("standard", {
          ...(initialTarget ? { target: initialTarget } : {}),
          opaque,
          setup: "true",
          setupEnv: ["QA_WORKER_FLAG"],
          desktop: true,
          binary: "/opt/crabbox",
        }),
      },
    },
  };
  const patches: ConfigPatchParams[] = [];
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      return configSnapshot(config, patches.length ? "after" : "before");
    }
    if (method === "environments.list") {
      return isCatalog(method, params)
        ? { environments: [], profiles: [{ id: "worker", operatingSystems: systems }] }
        : { environments: [] };
    }
    if (method !== "config.patch" || !validateConfigPatchParams(params)) {
      throw new Error(`Unexpected request ${method}`);
    }
    patches.push(params);
    const merged = applyMergePatch(config, JSON.parse(params.raw), { mergeObjectArraysById: true });
    if (!isRecord(merged)) {
      throw new Error("Expected merged configuration");
    }
    config = merged;
    return { ok: true, config, hash: "after" };
  });
  const { page } = mountProfiles({ request } as unknown as GatewayBrowserClient);
  const row = await waitForSolid(() => profileRow(page, "worker"));
  await waitEnabled(row, "Edit");
  click(row, "Edit");
  await waitForSolid(() => expect(page.querySelector("textarea")).not.toBeNull());
  const select = osSelect(page);
  if (systems.length >= 2 || (initialTarget && !systems.some((s) => s.id === initialTarget))) {
    const editor = expectDefined(select, "Operating system");
    expect(editor.value).toBe(initialTarget ?? "");
    if (systems.some((s) => s.id === "future-os")) {
      const disabled = expectDefined(
        [...editor.options].find((o) => o.value === "future-os"),
        "Disabled OS",
      );
      expect(disabled).toMatchObject({
        disabled: true,
        textContent: expect.stringContaining("Upgrade the worker provider."),
      });
    }
    change(editor, expectDefined(target, "Selected OS"));
  } else {
    expect(select).toBeNull();
  }
  change(expectDefined(page.querySelector("textarea"), "Setup"), "");
  expectDefined(page.querySelector<HTMLInputElement>(".settings-toggle__input"), "Desktop").click();
  change(expectDefined(field(page, "Crabbox binary"), "Binary"), "");
  click(page, "Save");
  await waitText(() => page, "Enter a setup command or clear the setup environment names.");
  expect(patches).toHaveLength(0);
  change(expectDefined(field(page, "Setup environment names"), "Setup names"), "");
  click(page, "Save");
  await waitText(() => page, "Profile saved.");
  expect(patches[0]).toMatchObject({
    baseHash: "before",
    replacePaths: ["cloudWorkers.profiles.worker.settings.setupEnv"],
  });
  expect(config).toHaveProperty("cloudWorkers.profiles.worker.settings", {
    provider: "aws",
    class: "standard",
    ttl: "8h",
    idleTimeout: "45m",
    ...(target ? { target } : {}),
    opaque,
  });
  expect(request).not.toHaveBeenCalledWith("environments.prepare", expect.anything());
  const savedRow = profileRow(page, "worker");
  if (target && target !== "linux") {
    expect(savedRow.textContent).toContain(
      `Operating system: ${systems.find((s) => s.id === target)?.label ?? target}`,
    );
  } else {
    expect(savedRow.textContent).not.toContain("Operating system:");
  }
  click(savedRow, "Edit");
  await waitForSolid(() => expect(page.querySelector("textarea")).not.toBeNull());
  if (systems.length >= 2) {
    expect(osSelect(page)?.value).toBe(target || "");
  } else {
    expect(osSelect(page)).toBeNull();
  }
  click(page, "Cancel");
  click(page, "Add profile");
  await waitForSolid(() => expect(field(page, "Profile ID")).not.toBeNull());
  expect(osSelect(page)).toBeNull();
});
