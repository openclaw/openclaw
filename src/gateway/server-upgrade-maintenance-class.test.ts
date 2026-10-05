import { expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { assertGatewayPluginFreeMaintenanceConfig } from "../infra/upgrade-recipes/maintenance-config.js";

it("accepts only an authored plugin-free policy without changing it", () => {
  const config: OpenClawConfig = { plugins: { enabled: false }, hooks: { enabled: false } };
  const before = structuredClone(config);
  expect(() => assertGatewayPluginFreeMaintenanceConfig(config)).not.toThrow();
  expect(config).toEqual(before);
});

it.each<OpenClawConfig>([
  {},
  { plugins: { enabled: true } },
  { plugins: { enabled: false, entries: { unknown: { enabled: true } } } },
  { plugins: { enabled: false }, hooks: { enabled: true } },
  {
    plugins: { enabled: false },
    secrets: { providers: { dangerous: { source: "exec", command: "/bin/false" } } },
  },
])("refuses unknown effects without silently disabling authored configuration", (config) => {
  const before = structuredClone(config);
  expect(() => assertGatewayPluginFreeMaintenanceConfig(config)).toThrow("maintenance refused");
  expect(config).toEqual(before);
});
