import { expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME } from "./legacy-config-migrations.runtime.js";

it("retires CLI adapter maps while preserving model selection", () => {
  const raw = {
    agents: {
      defaults: {
        model: "anthropic/claude-sonnet-4-6",
        cliBackends: {
          legacy: {
            command: "/opt/backend",
            sessionArg: "--session",
            reliability: {
              outputLimits: {},
              watchdog: {
                fresh: { noOutputTimeoutMs: 5_000 },
                resume: { noOutputTimeoutMs: 5_000 },
              },
            },
          },
        },
      },
    },
  };
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME) {
    migration.apply(raw, changes);
  }
  expect(raw).toEqual({ agents: { defaults: { model: "anthropic/claude-sonnet-4-6" } } });
  expect(changes.join("\n")).toContain("https://docs.openclaw.ai/plugins/cli-backend-plugins");
});
