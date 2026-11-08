/** Test bootstrap shim for Telegram runtime-secret surface coverage. */
import { vi } from "vitest";
import { resolveRelativeBundledPluginPublicModuleId } from "../test-utils/bundled-plugin-public-surface.js";
import type { loadChannelSecretContractApi } from "./channel-contract-api.js";

// Load the fixed fixture through the test runner, independent of ambient discovery.
const moduleId = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "telegram",
  artifactBasename: "secret-contract-api.js",
});
const telegramSecrets: NonNullable<ReturnType<typeof loadChannelSecretContractApi>> =
  await import(moduleId);
if (!telegramSecrets.collectRuntimeConfigAssignments) {
  throw new Error("Missing Telegram secret contract api");
}
const telegramAssignments = telegramSecrets.collectRuntimeConfigAssignments;

// Use the real bundled Telegram secret contract while avoiding plugin bootstrap.
vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) =>
    id === "telegram"
      ? {
          secrets: {
            collectRuntimeConfigAssignments: telegramAssignments,
          },
        }
      : undefined,
  getBootstrapChannelSecrets: (id: string) =>
    id === "telegram"
      ? {
          collectRuntimeConfigAssignments: telegramAssignments,
        }
      : undefined,
}));
