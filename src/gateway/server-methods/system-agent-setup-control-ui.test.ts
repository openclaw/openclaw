/* @vitest-environment jsdom */
import "../../../ui/src/test-helpers/dom.setup.ts";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createFirstRunContext,
  useFirstRunFixtures,
} from "../../../ui/src/pages/model-setup/model-setup-first-run.test-support.ts";
import { page as modelSetupRoute } from "../../../ui/src/pages/model-setup/route.ts";
import { createApplicationContextProvider } from "../../../ui/src/test-helpers/application-context.ts";
import { cleanupSolid, mountSolid } from "../../../ui/src/test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../ui/src/test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../ui/src/test-helpers/solid-settle.ts";
import { createConfigFileSnapshot } from "../../config/io.snapshot-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { initializeNativeSessionCatalogPreferences } from "../../plugins/native-session-catalog-config.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { invoke, makeContext } from "./system-agent-setup.test-support.js";

const braveManifestResult = loadPluginManifest(path.resolve("extensions/brave"));
if (!braveManifestResult.ok) {
  throw new Error(braveManifestResult.error);
}
const braveManifest = braveManifestResult.manifest;

const fixture = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshotWithPluginMetadata: async () => ({
    snapshot: createConfigFileSnapshot({
      path: "/tmp/synthetic-onboarding/openclaw.json",
      exists: true,
      valid: true,
      raw: null,
      parsed: fixture.config,
      sourceConfig: fixture.config,
      runtimeConfig: fixture.config,
      issues: [],
      warnings: [],
      legacyIssues: [],
    }),
    pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
      plugins: [
        { id: braveManifest.id, setup: braveManifest.setup, contracts: braveManifest.contracts },
        { id: "legacy", setup: { providers: [{ id: "legacy", authMethods: ["api-key"] }] } },
        {
          id: "mixed",
          providers: ["model"],
          setup: {
            nativeSessionCatalog: { label: "Fixture archive", legacyDefaultEnabled: true },
            providers: [
              { id: "model", authMethods: ["api-key"] },
              { id: "search", envVars: ["MIXED_SEARCH_API_KEY"] },
            ],
          },
          contracts: { webSearchProviders: ["search"] },
        },
      ],
    }),
  }),
}));
vi.mock("../../plugins/provider-install-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-install-catalog.js")>()),
  resolveProviderInstallCatalogEntries: () => [],
}));
vi.mock("../../commands/onboard-inference.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/onboard-inference.js")>()),
  detectInferenceBackends: async () => [],
}));

useFirstRunFixtures("test-device-key");
afterEach(async () => {
  cleanupSolid();
  await vi.dynamicImportSettled();
});

it("uses server-owned opt-in and inference providers for the selected agent", async () => {
  fixture.config = initializeNativeSessionCatalogPreferences({
    agents: { ownership: "explicit", entries: { main: {}, research: {} } },
  });
  const { context, request } = createFirstRunContext();
  const agentId = "research";
  Object.assign(context.agentSelection.state, { selectedId: agentId, scopeId: agentId });
  request.mockImplementation(async (method, params) => {
    if (method === "openclaw.setup.detect") {
      const [response] = await invoke(method, makeContext().context, params);
      expect(response?.ok).toBe(true);
      return response?.payload;
    }
    if (method === "openclaw.setup.auth.start") {
      return { done: true, status: "cancelled" };
    }
    throw new Error(`Unexpected setup RPC: ${method}`);
  });
  const provider = createApplicationContextProvider(context);
  document.body.append(provider);
  const route = await modelSetupRoute.component();
  const props = { data: { firstRun: true }, loaderPending: false, presented: true };
  const { container: page } = mountSolid(() => route.renderSolid(props), {
    container: provider,
    wrapper: createSolidApplicationContextProvider(context).wrapper,
  });
  await waitForSolid(() => expect(request).toHaveBeenCalled());
  await request.mock.results[0]!.value;
  await waitForSolid(() =>
    expect(page.querySelector('[data-auth-choice="custom-api-key"] button')).not.toBeNull(),
  );
  expect(request.mock.calls[0]?.slice(0, 2)).toEqual(["openclaw.setup.detect", { agentId }]);
  const checkbox = page.querySelector<HTMLInputElement>(".model-setup__native-discovery input");
  expect(checkbox?.checked).toBe(false);
  expect(page.textContent).toContain("Fixture archive");
  for (const [choice, present] of [
    ["model", true],
    ["legacy", true],
    ["brave", false],
    ["search", false],
  ] as const) {
    expect(page.querySelector(`[data-auth-choice="${choice}-api-key"]`) !== null).toBe(present);
  }
  page.querySelector<HTMLButtonElement>('[data-auth-choice="custom-api-key"] button')!.click();
  await waitForSolid(() =>
    expect(request.mock.calls.some(([method]) => method === "openclaw.setup.auth.start")).toBe(
      true,
    ),
  );
  const activation = request.mock.calls.find(
    ([method]) => method === "openclaw.setup.auth.start",
  )![1];
  expect(activation).toMatchObject({
    authChoice: "custom-api-key",
    agentId,
    nativeSessionCatalogsEnabled: false,
  });
});
