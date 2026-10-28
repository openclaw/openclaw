import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  readDeferredPluginMigrationsAsync,
  recordDeferredPluginMigrations,
} from "../infra/deferred-plugin-migrations.js";
import { disposePluginRegistryInstances } from "../plugins/runtime.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadGatewayStartupPluginRuntime } from "./server-startup-plugins.js";

it.each([
  "ready",
  "stateless",
  "required-stateless",
  "default",
  "after-session-repair",
  "detector-failed",
  "config-invalid",
])(
  "settles only inspected, already-complete plugin upgrades on Gateway startup: %s",
  async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const root = state.path("plugin");
      fs.mkdirSync(root);
      fs.writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({
          name: "upgrade-fixture",
          version: "2026.10.8",
          type: "module",
          openclaw: { extensions: ["./index.js"] },
        }),
      );
      fs.writeFileSync(path.join(root, "index.js"), "export default { register() {} };\n");
      const actions = scenario.endsWith("stateless")
        ? []
        : [{ id: "data" }, { id: "repair", doctorOnly: true, phase: "after-session-repair" }];
      fs.writeFileSync(
        path.join(root, "openclaw.plugin.json"),
        JSON.stringify({
          id: "upgrade-fixture",
          configSchema: { type: "object", additionalProperties: false },
          doctorContract: { stateMigrations: actions },
        }),
      );
      fs.writeFileSync(
        path.join(root, "doctor-contract-api.js"),
        `
        export const stateMigrations = ${JSON.stringify(actions)}.map(action => ({
          ...action, label: action.id,
          detectLegacyState() {
            if (${JSON.stringify(scenario)} === 'detector-failed') throw Error('inspection unavailable');
            return ${JSON.stringify(scenario)} === (action.phase ?? 'default') ? {preview: ['legacy data']} : null;
          },
          migrateLegacyState() { throw Error('Gateway must never run offline repairs'); }
        }));
      `,
      );
      const cfg = {
        plugins: {
          allow: ["upgrade-fixture"],
          load: { paths: [root] },
          entries: {
            "upgrade-fixture": {
              enabled: true,
              config: scenario === "config-invalid" ? { retired: true } : {},
            },
          },
        },
      };
      await state.writeConfig(cfg);
      const pending = {
        pluginId: "upgrade-fixture",
        ...(scenario === "stateless" ? {} : { requiresStateMigration: true as const }),
        reason: "Installed plugin has not confirmed data/settings readiness",
        command: "openclaw doctor --fix",
      };
      await recordDeferredPluginMigrations({ env: state.env, pending: [pending] });
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
      const loaded = await loadGatewayStartupPluginRuntime({
        cfg,
        log,
        baseMethods: [],
        startupPluginIds: ["upgrade-fixture"],
      });
      try {
        const ready = scenario === "ready" || scenario === "stateless";
        expect(await readDeferredPluginMigrationsAsync({ env: state.env })).toEqual(
          ready ? [] : [pending],
        );
        expect(
          loaded.pluginRegistry.plugins.find(({ id }) => id === pending.pluginId)?.status,
        ).toBe(ready ? "loaded" : "error");
        if (!ready) {
          expect(log.warn.mock.calls.flat().join("\n")).toContain(
            scenario === "detector-failed"
              ? "inspection unavailable"
              : scenario === "required-stateless"
                ? "no detector for the required state migration"
                : scenario === "config-invalid"
                  ? "config repair"
                  : scenario,
          );
        }
      } finally {
        loaded.retireGatewayRuntimeBindings();
        await disposePluginRegistryInstances(loaded.pluginRegistry);
      }
    });
  },
);
