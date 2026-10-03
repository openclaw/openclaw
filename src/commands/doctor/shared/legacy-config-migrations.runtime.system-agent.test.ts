import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAmbientOwnerAgentId } from "../../../agents/agent-scope-config.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import type {
  AgentDefaultsConfig,
  AgentEntryConfig,
  OpenClawConfig,
} from "../../../config/types.js";
import { resolveHeartbeatAgents } from "../../doctor-heartbeat-legacy.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";
import { migrateLegacyConfig } from "./legacy-config-migrate.js";
import { prepareLegacyConfigMigrationRuntime } from "./legacy-config-migrate.test-support.js";
import {
  findLegacySystemAgentOwnerIssue,
  LEGACY_CONFIG_MIGRATIONS_RUNTIME_SYSTEM_AGENT,
} from "./legacy-config-migrations.runtime.system-agent.js";

let restore: (() => void) | undefined;
beforeAll(async () => {
  restore = await prepareLegacyConfigMigrationRuntime();
});
afterAll(() => restore?.());
const migrate = (raw: unknown) =>
  applyLegacyDoctorMigrations(raw, { sourceConfigBeforeMigrations: raw });
type LegacyAgentEntries = NonNullable<
  NonNullable<OpenClawConfigWithLegacyRoster["agents"]>["entries"]
>;
function roster(entries: LegacyAgentEntries, shape: string) {
  return shape === "entries"
    ? { entries }
    : {
        list: Object.entries(entries).map(([id, config]) => Object.assign({ id }, config)),
      };
}

it("removes crestodian without mutating the separately retired systemAgent block", () => {
  const raw = {
    crestodian: { rescue: { enabled: true, ownerDmOnly: false } },
    systemAgent: { rescue: { enabled: false } },
  };
  LEGACY_CONFIG_MIGRATIONS_RUNTIME_SYSTEM_AGENT[0]?.apply(raw, []);
  expect(raw).toEqual({ systemAgent: { rescue: { enabled: false } } });
});

describe("ambient owner migration", () => {
  it.each(["entries", "list"])("restores ownership from markerless %s rosters", (shape) => {
    const raw: OpenClawConfigWithLegacyRoster = {
      agents: roster({ ops: {}, main: {} }, shape),
    };
    expect(() => resolveAmbientOwnerAgentId(raw)).toThrow("no explicit owner");
    expect(resolveHeartbeatAgents(raw)).toEqual([]);
    expect(findLegacyConfigIssues(raw)).not.toContainEqual(
      expect.objectContaining({ path: "agents" }),
    );
    const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
    expect(result.config).not.toBeNull();
    const migrated = result.config!;
    expect(migrated.agents?.defaults).toMatchObject({
      systemAgent: { agentId: "main" },
      heartbeat: { agentId: "main" },
    });
    expect(resolveAmbientOwnerAgentId(migrated)).toBe("main");
    expect(resolveHeartbeatAgents(migrated).map(({ agentId }) => agentId)).toEqual(["main"]);
    expect(migrate(migrated)).toEqual({ next: null, changes: [] });
    expect(raw.agents?.defaults).toBeUndefined();
  });

  it.each<{ entries: LegacyAgentEntries; owner: string; materialized: boolean }>([
    { entries: { ops: {} }, owner: "ops", materialized: false },
    { entries: { main: {}, ops: { default: true } }, owner: "ops", materialized: true },
  ])(
    "preserves resolved owners while retiring markers: $entries",
    ({ entries, owner, materialized }) => {
      const raw: OpenClawConfigWithLegacyRoster = { agents: { entries } };
      expect(resolveAmbientOwnerAgentId(raw)).toBe(owner);
      expect(findLegacySystemAgentOwnerIssue(raw)).toBeUndefined();
      const migrated: OpenClawConfig = migrate(raw).next ?? raw;
      expect(migrated.agents?.defaults?.systemAgent).toEqual(
        materialized ? { agentId: owner } : undefined,
      );
      expect(migrated.agents?.defaults?.heartbeat).toEqual(
        materialized ? { agentId: owner } : undefined,
      );
      expect(migrated.agents?.entries?.ops).not.toHaveProperty("default");
      expect(resolveAmbientOwnerAgentId(migrated)).toBe(owner);
      expect(migrate(migrated)).toEqual({ next: null, changes: [] });
    },
  );

  it("seeds a marked default ignored by explicit ownership", () => {
    const raw: OpenClawConfigWithLegacyRoster = {
      agents: { ownership: "explicit", entries: { main: {}, ops: { default: true } } },
    };
    expect(() => resolveAmbientOwnerAgentId(raw)).toThrow("no explicit owner");
    expect(migrate(raw).next).toHaveProperty("agents.defaults.systemAgent.agentId", "ops");
  });

  it.each<{
    defaults: AgentDefaultsConfig;
    entries: Record<string, AgentEntryConfig>;
    owners: string[];
  }>([
    {
      defaults: { heartbeat: { agentId: "ops" } },
      entries: { main: {}, ops: {} },
      owners: ["ops"],
    },
    {
      defaults: { heartbeat: { every: "1h" } },
      entries: { main: {}, ops: {} },
      owners: ["main", "ops"],
    },
    { defaults: {}, entries: { main: {}, ops: { heartbeat: { every: "1h" } } }, owners: ["ops"] },
  ])("preserves heartbeat enrollment: $defaults $entries", ({ defaults, entries, owners }) => {
    const raw: OpenClawConfig = { agents: { defaults, entries } };
    expect(resolveHeartbeatAgents(raw).map(({ agentId }) => agentId)).toEqual(owners);
    const migrated: OpenClawConfig = migrate(raw).next ?? {};
    expect(migrated.agents?.defaults?.systemAgent?.agentId).toBe("main");
    expect(migrated.agents?.defaults?.heartbeat).toEqual(defaults.heartbeat);
    expect(resolveHeartbeatAgents(migrated).map(({ agentId }) => agentId)).toEqual(owners);
  });

  it.each([
    { agents: { entries: { ops: {}, worker: {} } } },
    { agents: { entries: { main: {}, ops: {} }, defaults: { systemAgent: { agentId: "ops" } } } },
  ])("stamps ownership without changing ambient owners: %j", (raw) => {
    const result = migrate(raw);
    expect(result).toEqual({
      next: { agents: { ...raw.agents, ownership: "explicit" } },
      changes: ["Stamped the multi-agent roster for explicit per-surface ownership."],
    });
    expect(migrate(result.next)).toEqual({ next: null, changes: [] });
  });

  it.each([
    {},
    { agents: { entries: { main: { default: true }, ops: { default: true } } } },
    { agents: { entries: { main: {} }, defaults: { systemAgent: null } } },
  ])("leaves absent, ambiguous and explicit owners alone: %j", (raw) => {
    expect(migrate(raw)).toEqual({ next: null, changes: [] });
  });
});
