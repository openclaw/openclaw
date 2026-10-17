/* @vitest-environment jsdom */
import "../../../ui/src/test-helpers/dom.setup.ts";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../../ui/src/i18n/index.ts";
import { createFirstRunContext } from "../../../ui/src/pages/model-setup/model-setup-first-run.test-support.ts";
import { page as modelSetupRoute } from "../../../ui/src/pages/model-setup/route.ts";
import { createApplicationContextProvider } from "../../../ui/src/test-helpers/application-context.ts";
import { cleanupSolid, mountSolid } from "../../../ui/src/test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../../ui/src/test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../../ui/src/test-helpers/solid-settle.ts";
import { createStorageMock } from "../../../ui/src/test-helpers/storage.ts";
import { applyWizardMetadata } from "../../commands/onboard-helpers.js";
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
  exists: false,
  additionalCatalog: false,
  providerCapabilities: false,
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshotWithPluginMetadata: async () => ({
    snapshot: createConfigFileSnapshot({
      path: "/tmp/synthetic-onboarding/openclaw.json",
      exists: fixture.exists,
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
      plugins: fixture.providerCapabilities
        ? [
            {
              id: braveManifest.id,
              setup: braveManifest.setup,
              contracts: braveManifest.contracts,
            },
            {
              id: "legacy",
              setup: { providers: [{ id: "legacy", authMethods: ["api-key"] }] },
            },
            {
              id: "mixed",
              providers: ["model"],
              setup: {
                providers: [
                  { id: "model", authMethods: ["api-key"] },
                  { id: "search", envVars: ["MIXED_SEARCH_API_KEY"] },
                ],
              },
              contracts: { webSearchProviders: ["search"] },
            },
          ]
        : fixture.additionalCatalog
          ? [
              {
                id: "fixture-catalog",
                setup: {
                  nativeSessionCatalog: { label: "Fixture archive", legacyDefaultEnabled: true },
                },
              },
            ]
          : [],
    }),
  }),
}));
vi.mock("../../plugins/provider-install-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/provider-install-catalog.js")>()),
  resolveProviderInstallCatalogEntries: () => [],
}));
// mock-isolation: Keep process discovery synthetic while exercising real config, RPC, and UI behavior.
vi.mock("../../system-agent/setup-inference.js", () => ({
  // Replace process discovery only; keep config, RPC and UI behavior real.
  detectSetupInference: async (_deps: unknown, agentId?: string) => {
    const { detectSetupInference } = await import("../../system-agent/setup-inference-detect.js");
    return detectSetupInference({ detectInferenceBackends: async () => [] }, agentId);
  },
}));

beforeEach(async () => {
  vi.stubGlobal("localStorage", createStorageMock());
  await i18n.setLocale("en");
});
afterEach(async () => {
  cleanupSolid();
  document.body.replaceChildren();
  await vi.dynamicImportSettled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  "unwritten",
  "initialized",
  "doctor",
  "onboard",
  "upgrade",
  "authored",
  "additional-catalog",
  "provider-capabilities",
] as const)(
  "uses server-owned first-install evidence for %s selected-agent setup",
  async (state) => {
    const authored: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {}, research: {} } },
    };
    fixture.exists = state !== "unwritten";
    fixture.additionalCatalog = state === "additional-catalog";
    fixture.providerCapabilities = state === "provider-capabilities";
    fixture.config =
      state === "unwritten"
        ? {}
        : state === "upgrade"
          ? authored
          : initializeNativeSessionCatalogPreferences(authored);
    if (state === "doctor" || state === "onboard") {
      fixture.config = applyWizardMetadata(fixture.config, { command: state, mode: "local" });
    }
    if (state === "authored") {
      fixture.config.plugins!.entries!.codex!.config = { sessionCatalog: { enabled: true } };
    }
    const { context, request } = createFirstRunContext();
    const agentId = state === "unwritten" ? "main" : "research";
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
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "openclaw.setup.detect",
      { agentId },
      expect.objectContaining({ timeoutMs: expect.any(Number), signal: expect.any(AbortSignal) }),
    );
    const checkbox = page.querySelector<HTMLInputElement>(".model-setup__native-discovery input");
    const required = state !== "upgrade" && state !== "authored";
    expect(checkbox && checkbox.checked).toBe(required ? false : null);
    if (fixture.additionalCatalog) {
      expect(page.textContent).toContain("Fixture archive");
    }
    if (fixture.providerCapabilities) {
      expect(page.querySelector('[data-auth-choice="model-api-key"]')).not.toBeNull();
      expect(page.querySelector('[data-auth-choice="legacy-api-key"]')).not.toBeNull();
      expect(page.querySelector('[data-auth-choice="brave-api-key"]')).toBeNull();
      expect(page.querySelector('[data-auth-choice="search-api-key"]')).toBeNull();
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
    expect(activation).toMatchObject({ authChoice: "custom-api-key", agentId });
    if (required) {
      expect(activation).toHaveProperty("nativeSessionCatalogsEnabled", false);
    } else {
      expect(activation).not.toHaveProperty("nativeSessionCatalogsEnabled");
    }
  },
);
