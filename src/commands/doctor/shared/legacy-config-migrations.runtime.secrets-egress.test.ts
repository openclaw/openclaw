import { expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { validateConfigObjectRaw } from "../../../config/validation.js";
import { LEGACY_CONFIG_MIGRATION_RUNTIME_SECRETS_EGRESS as migration } from "./legacy-config-migrations.runtime.secrets-egress.js";

function expectLegacyHostIssue(raw: unknown, key: string) {
  expect(findLegacyConfigIssues(raw).map((issue) => issue.path)).toContain(
    `secrets.egressProxy.${key}`,
  );
}

it("repairs unusable hostname entries even for a disabled proxy", () => {
  const raw = {
    secrets: { egressProxy: { enabled: false, bypassHosts: [123, "api.example.com:443"] } },
  };
  expect(validateConfigObjectRaw(raw).ok).toBe(false);
  expectLegacyHostIssue(raw, "bypassHosts");
  const changes: string[] = [];
  migration.apply(raw, changes);
  expect(raw).toEqual({ secrets: { egressProxy: { enabled: false } } });
  expect(changes).toEqual([
    'Removed unusable secrets.egressProxy.bypassHosts entries: 123, "api.example.com:443".',
  ]);
  expect(validateConfigObjectRaw(raw).ok).toBe(true);
});

it("keeps valid allowed hosts when dropping unusable entries", () => {
  const raw = {
    secrets: { egressProxy: { allowedHosts: ["good.example.com", "https://bad.example.com"] } },
  };
  expectLegacyHostIssue(raw, "allowedHosts");
  migration.apply(raw, []);
  expect(raw).toEqual({ secrets: { egressProxy: { allowedHosts: ["good.example.com"] } } });
});

it("leaves valid host arrays unchanged without reporting issues", () => {
  const raw = {
    secrets: {
      egressProxy: {
        enabled: false,
        allowedHosts: ["API.example.com.", "127.0.0.1", "API.example.com."],
        bypassHosts: ["good.example.com"],
      },
    },
  };
  const original = structuredClone(raw);
  const changes: string[] = [];
  expect(findLegacyConfigIssues(raw)).toEqual([]);
  migration.apply(raw, changes);
  expect(raw).toEqual(original);
  expect(changes).toEqual([]);
});
