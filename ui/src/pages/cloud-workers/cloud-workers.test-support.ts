import { expectDefined } from "@openclaw/normalization-core/expect";
import { createComponent, flush } from "solid-js";
import { afterEach, beforeEach, expect, onTestFinished, vi } from "vitest";
import type { EnvironmentSummary } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { sourceConfigSnapshot } from "../../lib/config/config-snapshot.test-support.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { ApplicationProvider } from "../../lib/reactive/context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  buildEnvironmentFixture,
  snapshotListFixture,
} from "./cloud-worker-snapshots.test-support.ts";
import { CloudWorkersPage } from "./cloud-workers-page.tsx";

export function button(container: Element, label: string) {
  const buttons = [...container.querySelectorAll<HTMLButtonElement>("button")];
  const match = buttons.find((entry) => entry.textContent?.trim() === label);
  return expectDefined(match, label);
}

function mountPage(
  methods: string[],
  options: {
    result?: ReturnType<typeof snapshotListFixture>;
    config?: Record<string, unknown>;
    response?: (method: string, params?: Record<string, unknown>) => unknown;
  } = {},
) {
  const result = options.result ?? snapshotListFixture();
  let config = options.config ?? {};
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    const response = options.response?.(method, params);
    if (response !== undefined) {
      return response;
    }
    switch (method) {
      case "environments.list":
        return { environments: [] };
      case "projects.list":
        return {
          projects: [
            { id: "app", displayName: "App", repoRoot: "/projects/app", source: "registered" },
          ],
        };
      case "worktrees.list":
        return { worktrees: [] };
      case "environments.prepare":
        return { environmentId: "build-app", preparationKey: "build-key", reused: false };
      case "environments.destroy":
        return {};
      case "config.get":
        return sourceConfigSnapshot(config, "snapshot-config");
      case "crabbox.images.list":
        return result;
      case "config.patch":
        config = { ...config, ...JSON.parse(String(params?.raw)) };
        return { ok: true, config, hash: "snapshot-config-updated" };
    }
    throw new Error(`Unexpected request ${method}`);
  });
  const client = { request } as unknown as GatewayBrowserClient;
  const harness = createGatewayHarness(client);
  harness.publish(true, client, gatewayHelloForMethods(methods));
  const runtimeConfig = createRuntimeConfigCapability(harness.gateway);
  const context = {
    gateway: harness.gateway,
    runtimeConfig,
    router: { subscribe: () => () => {} },
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  const mounted = mountSolid(() =>
    createComponent(ApplicationProvider, {
      value: context,
      get children() {
        return createComponent(CloudWorkersPage, {});
      },
    }),
  );
  // dom.setup owns unmounting; Vitest finishes capability cleanup afterward.
  onTestFinished(() => runtimeConfig.dispose());
  const page = expectDefined(
    mounted.container.querySelector("openclaw-cloud-workers-page"),
    "Cloud workers page",
  );
  return { page, request, harness, client };
}

type WorkerDetails = NonNullable<NonNullable<EnvironmentSummary["preparation"]>["details"]>;
export function makeWorker(
  state = "provisioning",
  options: {
    error?: string;
    status?: EnvironmentSummary["status"];
    details?: Partial<WorkerDetails> | null;
    worker?: Partial<NonNullable<EnvironmentSummary["worker"]>>;
  } = {},
) {
  const base = buildEnvironmentFixture(state, options.error);
  return {
    ...base,
    status: options.status ?? base.status,
    preparation: {
      ...base.preparation,
      details:
        options.details === null ? undefined : { ...base.preparation.details, ...options.details },
    },
    worker: { ...base.worker, ...options.worker },
  };
}

export const preparedInventory =
  (environments: ReturnType<typeof makeWorker>[]) =>
  (method: string, params?: Record<string, unknown>) =>
    method === "environments.list" && params?.includePreparedDetails
      ? { environments, profiles: [] }
      : undefined;

export function machineProfile(machineClass = "standard", settings: Record<string, unknown> = {}) {
  return { provider: "crabbox", settings: { provider: "aws", class: machineClass, ...settings } };
}

export function setupSnapshotTests() {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    await i18n.setLocale("en");
  });
  afterEach(() => vi.useRealTimers());
  return mountPage;
}

export const sheet = (page: Element) =>
  expectDefined(page.querySelector(".cloud-environments__sheet"), "Environment sheet");

export function change(
  element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string,
) {
  element.value = value;
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
  flush();
}

export function click(page: Element, label: string) {
  button(page, label).click();
  flush();
}

export const configSnapshot = (config: Record<string, unknown>, hash: string) => ({
  ...sourceConfigSnapshot(config, hash),
  appliedConfigHash: hash,
});

type Request = ReturnType<typeof mountPage>["request"];

export function configPatch(request: Request) {
  return waitForSolid(() => {
    const call = request.mock.calls.find(([method]) => method === "config.patch");
    return expectDefined(call, "Config patch request")[1];
  });
}

export const waitText = (element: () => Element, text: string) =>
  waitForSolid(() => expect(element().textContent).toContain(text));

export const waitRequest = (request: Request, method: string, params: Record<string, unknown>) =>
  waitForSolid(() => expect(request).toHaveBeenCalledWith(method, params));
