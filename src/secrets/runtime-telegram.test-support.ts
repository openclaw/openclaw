/** Test bootstrap shim for Telegram runtime-secret surface coverage. */
import { vi } from "vitest";
import { collectRuntimeConfigAssignments as telegramAssignments } from "../../extensions/telegram/secret-contract-api.js";

// This fixture always needs Telegram, even when a Gateway test disables discovery.

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
