import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, expect, it, vi } from "vitest";
import type * as Catalog from "../capability-catalog-context.types.js";

const rejectRuntimeImport = vi.hoisted(() => () => {
  throw new Error("cold catalog imported host runtime/auth");
});
// mock-isolation: cold catalogs must fail if they import the plugin runtime loader.
vi.mock("../loader-runtime-load.js", rejectRuntimeImport);
// mock-isolation: cold catalogs must fail if they import provider runtime state.
vi.mock("../capability-provider-runtime.js", rejectRuntimeImport);
// mock-isolation: cold catalogs must fail if they import provider authentication.
vi.mock("../../plugin-sdk/provider-auth.js", rejectRuntimeImport);
// mock-isolation: cold catalogs must fail if they import transcription transport.
vi.mock("../../realtime-transcription/websocket-session.js", rejectRuntimeImport);
// mock-isolation: cold catalogs must fail if they import live request configuration.
vi.mock("../../agents/provider-request-config.js", rejectRuntimeImport);
// mock-isolation: cold catalogs must fail if they import proxy capture runtime state.
vi.mock("../../proxy-capture/runtime.js", rejectRuntimeImport);
// mock-isolation: cold catalogs must fail if they import HTTP response handling.
vi.mock("../../infra/http-body.js", rejectRuntimeImport);
// mock-isolation: cold catalogs must fail if they import host logging/redaction state.
vi.mock("../../logging/redact.js", rejectRuntimeImport);

const extensions = fileURLToPath(new URL("../../../extensions/", import.meta.url));
const families = [
  "speechProviders",
  "realtimeTranscriptionProviders",
  "realtimeVoiceProviders",
] as const;
const fixtures = fs.readdirSync(extensions).flatMap((dir) => {
  const root = path.join(extensions, dir);
  const manifestPath = path.join(root, "openclaw.plugin.json");
  if (!fs.existsSync(manifestPath)) {
    return [];
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const contracts = families.filter((key) => manifest.contracts?.[key]?.length);
  return contracts.length ? [{ dir, root, manifest, contracts }] : [];
});

const context: Catalog.PluginCapabilityCatalogHostContext = {
  isProviderApiKeyConfigured: rejectRuntimeImport,
  isProviderApiKeyConfiguredAsync: rejectRuntimeImport,
  isProviderAuthProfileConfigured: rejectRuntimeImport,
  isProviderAuthProfileConfiguredAsync: rejectRuntimeImport,
  resolveAgentDir: rejectRuntimeImport,
  createRealtimeTranscriptionWebSocketSession: rejectRuntimeImport,
  resolveProviderRequestHeaders: rejectRuntimeImport,
  resolveProviderAuthProfileApiKey: rejectRuntimeImport,
  resolveApiKeyForProvider: rejectRuntimeImport,
  captureWsEvent: rejectRuntimeImport,
  captureWsEventAsync: rejectRuntimeImport,
  createDebugProxyWebSocketAgent: rejectRuntimeImport,
  resolveDebugProxySettings: rejectRuntimeImport,
  fetchWithSsrFGuard: rejectRuntimeImport,
  createProviderHttpError: rejectRuntimeImport,
  readProviderJsonResponse: rejectRuntimeImport,
  readProviderTextResponse: rejectRuntimeImport,
  formatErrorMessage: rejectRuntimeImport,
  warn: rejectRuntimeImport,
  redactSensitiveText: rejectRuntimeImport,
};

it.each(fixtures)(
  "constructs $dir descriptors without runtime or auth discovery",
  async ({ root, manifest, contracts }) => {
    const module = await import(
      pathToFileURL(path.resolve(root, manifest.capabilityCatalogEntry)).href
    );
    const entry = module.default as Catalog.PluginCapabilityCatalogHostEntry;
    const catalog = typeof entry === "function" ? entry(context) : entry;
    for (const family of contracts) {
      const ids: string[] = manifest.contracts[family];
      const providers = catalog[family]!;
      for (const id of ids) {
        expect(
          providers.some((provider) => provider.id === id || provider.aliases?.includes(id)),
        ).toBe(true);
      }
      expect(providers.every((provider) => ids.includes(provider.id))).toBe(true);
      for (const provider of providers) {
        expect(provider).toMatchObject({
          label: expect.any(String),
          isConfigured: expect.any(Function),
        });
      }
    }
    // OpenAI's readiness/control methods are deliberately non-enumerable.
    for (const provider of catalog.realtimeVoiceProviders ?? []) {
      for (const key of Object.getOwnPropertySymbols(provider)) {
        expect(Object.getOwnPropertyDescriptor(provider, key)?.enumerable).toBe(false);
      }
    }
  },
);
afterAll(() => {
  vi.doUnmock("../loader-runtime-load.js");
  vi.doUnmock("../capability-provider-runtime.js");
  vi.doUnmock("../../plugin-sdk/provider-auth.js");
  vi.doUnmock("../../realtime-transcription/websocket-session.js");
  vi.doUnmock("../../agents/provider-request-config.js");
  vi.doUnmock("../../proxy-capture/runtime.js");
  vi.doUnmock("../../infra/http-body.js");
  vi.doUnmock("../../logging/redact.js");
  vi.resetModules();
});
