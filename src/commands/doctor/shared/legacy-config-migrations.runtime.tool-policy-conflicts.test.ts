// Covers doctor repair for tool policy scopes that set both allow and alsoAllow.
import { describe, expect, it } from "vitest";
import {
  isToolAllowed,
  resolveSandboxToolPolicyForAgent,
} from "../../../agents/sandbox/tool-policy.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { validateConfigObjectWithPlugins } from "../../../config/validation.js";
import { LEGACY_CONFIG_MIGRATIONS } from "./legacy-config-migrations.js";

// Exercise the registered migration list so the test fails if the repair is never wired in.
function runRegisteredMigrations(raw: unknown): { config: unknown; changes: string[] } {
  const next = structuredClone(raw) as Record<string, unknown>;
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS) {
    migration.apply(next, changes);
  }
  return { config: next, changes };
}

function isValid(config: unknown): boolean {
  return validateConfigObjectWithPlugins(config, { pluginValidation: "core-only" }).ok;
}

describe("tool policy allow/alsoAllow conflict repair", () => {
  it.each([
    {
      name: "top-level without a profile",
      raw: { tools: { allow: ["message", "read"], alsoAllow: ["exec"] } },
      paths: ["tools"],
      allow: ["message", "read", "exec"],
    },
    {
      name: "full profile",
      raw: { tools: { profile: "full", allow: ["message"], alsoAllow: ["exec"] } },
      paths: ["tools"],
      allow: ["message", "exec"],
    },
    {
      name: "agent and provider scopes",
      raw: {
        tools: { byProvider: { sandbox: { allow: ["message"], alsoAllow: ["exec"] } } },
        agents: { entries: { sandbox: { tools: { allow: ["message"], alsoAllow: ["read"] } } } },
      },
      paths: ["tools.byProvider.sandbox", "agents.entries.sandbox.tools"],
    },
    {
      name: "profile-bound repair",
      raw: {
        tools: {
          profile: "messaging",
          allow: ["message"],
          alsoAllow: ["exec"],
          exec: { security: "allowlist" },
        },
      },
      paths: ["tools"],
    },
  ])("repairs conflicts in $name exactly once", ({ name, raw, paths, allow }) => {
    expect(isValid(raw)).toBe(false);
    const res = runRegisteredMigrations(raw);
    expect(isValid(res.config)).toBe(true);
    for (const path of paths) {
      expect(
        res.changes.filter((change) => change === `Merged ${path}.alsoAllow into ${path}.allow.`),
      ).toHaveLength(1);
    }
    if (allow) {
      expect(res.config).toMatchObject({ tools: { allow, alsoAllow: [] } });
    }
    if (name === "profile-bound repair") {
      expect(res.changes).toContain(
        'Set tools.profile to "full" so tools.allow controls explicit configured-section grants directly.',
      );
    }
    expect(runRegisteredMigrations(res.config)).toEqual({ config: res.config, changes: [] });
  });

  it.each([
    {
      scope: "agent",
      global: { alsoAllow: ["exec"] },
      agent: { allow: ["read", "message"], alsoAllow: ["message"] },
    },
    {
      scope: "global with an agent extras override",
      global: { allow: ["read"], alsoAllow: ["exec"] },
      agent: { alsoAllow: ["message"] },
    },
    {
      scope: "global with an empty agent extras override",
      global: { allow: ["read"], alsoAllow: ["exec"] },
      agent: { alsoAllow: [] },
    },
  ])("preserves sandbox permissions for a conflict at $scope", ({ global, agent }) => {
    const raw: OpenClawConfig = {
      tools: { sandbox: { tools: global } },
      agents: {
        ownership: "explicit",
        entries: { restricted: { tools: { sandbox: { tools: agent } } } },
      },
    };
    const before = resolveSandboxToolPolicyForAgent(raw, "restricted");
    expect(isToolAllowed(before, "read")).toBe(true);
    expect(isToolAllowed(before, "exec")).toBe(false);

    const res = runRegisteredMigrations(raw);
    const after = resolveSandboxToolPolicyForAgent(res.config as OpenClawConfig, "restricted");

    expect(isToolAllowed(after, "exec")).toBe(false);
    expect(after).toStrictEqual(before);
    expect(res.config).toMatchObject(raw);
    expect(res.changes.some((change) => change.startsWith("Merged "))).toBe(false);
  });

  it.each([
    { tools: { alsoAllow: ["exec"] } },
    {
      plugins: {
        entries: { acme: { config: { tools: { allow: ["message"], alsoAllow: ["exec"] } } } },
      },
    },
  ])("leaves non-conflicting or plugin-owned config untouched: %j", (raw) => {
    expect(runRegisteredMigrations(raw)).toEqual({ config: raw, changes: [] });
  });
});
