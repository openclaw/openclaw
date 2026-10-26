import { expectDefined } from "@openclaw/normalization-core";
import { createComponent } from "solid-js";
import { afterEach, beforeEach, vi } from "vitest";
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
import { snapshotListFixture } from "./cloud-worker-snapshots.test-support.ts";
import { CloudWorkersPage } from "./cloud-workers-page.tsx";

export function button(container: Element, label: string) {
  return expectDefined(
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === label,
    ),
    label,
  );
}

export function setupSnapshotsDomSuite() {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    await i18n.setLocale("en");
  });
  afterEach(() => vi.useRealTimers());
}

export function mountPage(
  methods: string[],
  options: {
    result?: ReturnType<typeof snapshotListFixture>;
    config?: Record<string, unknown>;
    response?: (method: string, params?: Record<string, unknown>) => unknown;
    scopes?: string[];
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
  harness.publish(true, client, gatewayHelloForMethods(methods, options.scopes));
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
  return {
    page: expectDefined(
      mounted.container.querySelector("openclaw-cloud-workers-page"),
      "Cloud workers page",
    ),
    request,
    harness,
    client,
    dispose: () => {
      mounted.unmount();
      runtimeConfig.dispose();
    },
  };
}
