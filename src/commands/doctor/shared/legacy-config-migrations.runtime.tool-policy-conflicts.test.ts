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
const conflict = (allow = ["message"], alsoAllow = ["exec"]) => ({ allow, alsoAllow });
const globalConflict = conflict(["read"]);
const messageRead = ["message", "read"];
type Policy = { allow?: string[]; alsoAllow: string[] };

describe("tool policy allow/alsoAllow conflict repair", () => {
  const repairs: [string, unknown, string[], string[]?][] = [
    ["no profile", { tools: conflict(messageRead) }, ["tools"], [...messageRead, "exec"]],
    ["full profile", { tools: { profile: "full", ...conflict() } }, ["tools"], ["message", "exec"]],
    [
      "agent and provider scopes",
      {
        tools: { byProvider: { sandbox: conflict() } },
        agents: { entries: { sandbox: { tools: conflict(["message"], ["read"]) } } },
      },
      ["tools.byProvider.sandbox", "agents.entries.sandbox.tools"],
    ],
    [
      "profile-bound repair",
      { tools: { profile: "messaging", ...conflict(), exec: { security: "allowlist" } } },
      ["tools"],
    ],
  ];
  it.each(repairs)("repairs conflicts in %s exactly once", (name, raw, paths, allow) => {
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

  const sandboxCases: [string, Policy, Policy][] = [
    ["agent", { alsoAllow: ["exec"] }, conflict(["read", "message"], ["message"])],
    ["global with an agent extras override", globalConflict, { alsoAllow: ["message"] }],
    ["global with an empty agent extras override", globalConflict, { alsoAllow: [] }],
  ];
  it.each(sandboxCases)("preserves sandbox grants at %s", (_scope, global, agent) => {
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
    { plugins: { entries: { acme: { config: { tools: conflict() } } } } },
  ])("leaves non-conflicting or plugin-owned config untouched: %j", (raw) => {
    expect(runRegisteredMigrations(raw)).toEqual({ config: raw, changes: [] });
  });
});
