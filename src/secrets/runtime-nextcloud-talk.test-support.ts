/** Shared Nextcloud Talk secrets runtime fixtures. */
import { vi } from "vitest";
import { createRuntimeChannelSecretRegistry } from "./runtime-channel-secret.test-support.js";

/** Test-only bootstrap registry mock for Nextcloud Talk secret surface tests. */
const nextcloudTalkRegistry = createRuntimeChannelSecretRegistry(
  "nextcloud-talk",
  "Nextcloud Talk",
);

// Keep the hoisted mock lazy while loading the real contract during module initialization.
// mock-isolation: Use the real channel secret contract without loading plugin bootstrap state.
vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: (id: string) => nextcloudTalkRegistry.getBootstrapChannelPlugin(id),
  getBootstrapChannelSecrets: (id: string) => nextcloudTalkRegistry.getBootstrapChannelSecrets(id),
}));
