/* Shared jsdom harness for the Cloud workers snapshot suites. Keep DOM-only helpers
   here; the e2e suite imports the plain fixture module instead. */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { i18n } from "../../i18n/index.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { snapshotListFixture } from "./cloud-worker-snapshots.test-support.ts";
import "./cloud-workers-page.ts";

export function button(container: Element, label: string) {
  return expectDefined(
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === label,
    ),
    label,
  );
}

/** Each suite mocks the dialog and toast modules itself; this only resets them. */
export function setupSnapshotsDomSuite() {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(showConfirmDialog).mockResolvedValue(true);
    await i18n.setLocale("en");
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });
}

export function mountPage(
  methods: string[],
  options: {
    result?: ReturnType<typeof snapshotListFixture>;
    config?: Record<string, unknown>;
    failMutation?: boolean;
    response?: (method: string) => unknown;
    scopes?: string[];
  } = {},
) {
  let result = options.result ?? snapshotListFixture();
  let config = options.config ?? {};
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    const response = options.response?.(method);
    if (response !== undefined) {
      return response;
    }
    if (method === "environments.list") {
      return { environments: [] };
    }
    if (method === "projects.list") {
      return {
        projects: [
          { id: "app", displayName: "App", repoRoot: "/projects/app", source: "registered" },
        ],
      };
    }
    if (method === "worktrees.list") {
      return { worktrees: [] };
    }
    if (method === "environments.prepare") {
      return { environmentId: "build-app", preparationKey: "build-key", reused: false };
    }
    if (method === "environments.destroy") {
      return {};
    }
    if (method === "config.get") {
      return {
        config,
        sourceConfig: config,
        raw: JSON.stringify(config),
        hash: "snapshot-config",
        valid: true,
        issues: [],
      };
    }
    if (method === "crabbox.images.list") {
      return result;
    }
    if (method === "config.patch") {
      config = { ...config, ...JSON.parse(String(params?.raw)) };
      return { ok: true, config, hash: "snapshot-config-updated" };
    }
    if (
      ["crabbox.images.pin", "crabbox.images.delete", "crabbox.images.rollback"].includes(method)
    ) {
      if (options.failMutation) {
        throw new Error("Provider is unavailable");
      }
      if (method === "crabbox.images.delete") {
        result = {
          ...result,
          images: result.images.filter((image) => image.checkpointId !== params?.checkpointId),
        };
        return { status: "deleted" };
      }
      result = {
        ...result,
        images: result.images.map((image) =>
          image.checkpointId === params?.checkpointId
            ? { ...image, pinned: params?.pinned ? { atMs: 1234 } : undefined }
            : image,
        ),
      };
      return result.images.find((image) => image.checkpointId === params?.checkpointId);
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
    navigate: vi.fn(),
  } as unknown as ApplicationContext;
  const provider = createApplicationContextProvider(context);
  const page = document.createElement("openclaw-cloud-workers-page");
  provider.append(page);
  document.body.append(provider);
  return {
    page,
    request,
    harness,
    client,
    dispose: () => {
      provider.remove();
      runtimeConfig.dispose();
    },
  };
}
