import { expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_CLI_BACKENDS } from "./legacy-config-migrations.runtime.cli-backends.js";

it("retires CLI adapter maps while preserving model selection", () => {
  const raw = {
    agents: {
      defaults: {
        model: "anthropic/claude-sonnet-4-6",
        cliBackends: { legacy: { command: "/opt/backend" } },
      },
    },
  };
  const changes: string[] = [];
  LEGACY_CONFIG_MIGRATIONS_RUNTIME_CLI_BACKENDS[0]?.apply(raw, changes);
  expect(raw).toEqual({ agents: { defaults: { model: "anthropic/claude-sonnet-4-6" } } });
  expect(changes.join("\n")).toContain("https://docs.openclaw.ai/plugins/cli-backend-plugins");
});
