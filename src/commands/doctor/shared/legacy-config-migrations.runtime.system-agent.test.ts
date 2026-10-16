import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAmbientOwnerAgentId } from "../../../agents/agent-scope-config.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { resolveHeartbeatAgents } from "../../../infra/heartbeat-config.js";
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

  it("preserves the resolved owner while retiring its default marker", () => {
    const raw: OpenClawConfigWithLegacyRoster = {
      agents: { entries: { main: {}, ops: { default: true } } },
    };
    expect(resolveAmbientOwnerAgentId(raw)).toBe("ops");
    expect(findLegacySystemAgentOwnerIssue(raw)).toBeUndefined();
    const migrated: OpenClawConfig = migrate(raw).next ?? raw;
    expect(migrated.agents?.defaults?.systemAgent).toEqual({ agentId: "ops" });
    expect(migrated.agents?.defaults?.heartbeat).toEqual({ agentId: "ops" });
    expect(migrated.agents?.entries?.ops).not.toHaveProperty("default");
    expect(resolveAmbientOwnerAgentId(migrated)).toBe("ops");
    expect(migrate(migrated)).toEqual({ next: null, changes: [] });
  });

  it("seeds a marked default ignored by explicit ownership", () => {
    const raw: OpenClawConfigWithLegacyRoster = {
      agents: { ownership: "explicit", entries: { main: {}, ops: { default: true } } },
    };
    expect(() => resolveAmbientOwnerAgentId(raw)).toThrow("no explicit owner");
    expect(migrate(raw).next).toHaveProperty("agents.defaults.systemAgent.agentId", "ops");
  });

  it("preserves per-agent heartbeat enrollment", () => {
    const raw: OpenClawConfig = {
      agents: { defaults: {}, entries: { main: {}, ops: { heartbeat: { every: "1h" } } } },
    };
    expect(resolveHeartbeatAgents(raw).map(({ agentId }) => agentId)).toEqual(["ops"]);
    const migrated: OpenClawConfig = migrate(raw).next ?? {};
    expect(migrated.agents?.defaults?.systemAgent?.agentId).toBe("main");
    expect(migrated.agents?.defaults?.heartbeat).toEqual(undefined);
    expect(resolveHeartbeatAgents(migrated).map(({ agentId }) => agentId)).toEqual(["ops"]);
  });

  it("stamps ownership without selecting an ambient owner", () => {
    const raw = { agents: { entries: { ops: {}, worker: {} } } };
    const result = migrate(raw);
    expect(result).toEqual({
      next: { agents: { ...raw.agents, ownership: "explicit" } },
      changes: ["Stamped the multi-agent roster for explicit per-surface ownership."],
    });
    expect(migrate(result.next)).toEqual({ next: null, changes: [] });
  });

  it.each([{}, { agents: { entries: { main: {} }, defaults: { systemAgent: null } } }])(
    "leaves absent and explicit owners alone: %j",
    (raw) => {
      expect(migrate(raw)).toEqual({ next: null, changes: [] });
    },
  );
});
