import { afterAll, beforeAll, expect, it } from "vitest";
import { resolveAmbientOwnerAgentId } from "../../../agents/agent-scope-config.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import type { OpenClawConfigWithLegacyRoster } from "../../../config/legacy.roster.js";
import type { OpenClawConfig } from "../../../config/types.js";
import { resolveLegacyHeartbeatAgents } from "../../doctor-heartbeat-legacy.js";
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
const config = (agents: NonNullable<OpenClawConfigWithLegacyRoster["agents"]>) => ({ agents });
const heartbeatIds = (cfg: OpenClawConfigWithLegacyRoster) =>
  resolveLegacyHeartbeatAgents(cfg).map(({ agentId }) => agentId);
function expectOwner(cfg: OpenClawConfig, agentId: string) {
  expect(resolveAmbientOwnerAgentId(cfg)).toBe(agentId);
  expect(cfg.agents?.defaults?.systemAgent).toEqual({ agentId });
  expect(cfg).not.toHaveProperty("agents.defaults.heartbeat");
  expect(migrate(cfg)).toEqual({ next: null, changes: [] });
}

it("removes crestodian without mutating the separately retired systemAgent block", () => {
  const raw = {
    crestodian: { rescue: { enabled: true, ownerDmOnly: false } },
    systemAgent: { rescue: { enabled: false } },
  };
  LEGACY_CONFIG_MIGRATIONS_RUNTIME_SYSTEM_AGENT[0]?.apply(raw, []);
  expect(raw).toEqual({ systemAgent: { rescue: { enabled: false } } });
});

it.each(["entries", "list"])("restores ownership from markerless %s rosters", (shape) => {
  const raw = config(
    shape === "entries"
      ? { entries: { ops: {}, main: {} } }
      : { list: [{ id: "ops" }, { id: "main" }] },
  );
  expect(() => resolveAmbientOwnerAgentId(raw)).toThrow("no explicit owner");
  expect(heartbeatIds(raw)).toEqual([]);
  expect(findLegacyConfigIssues(raw)).not.toContainEqual(
    expect.objectContaining({ path: "agents" }),
  );
  const result = migrateLegacyConfig(raw, { sourceConfigBeforeMigrations: raw });
  expect(result.config).not.toBeNull();
  expectOwner(result.config!, "main");
  expect(heartbeatIds(result.config!)).toEqual(["main"]);
  expect(raw.agents.defaults).toBeUndefined();
});

it.each([false, true])("preserves the marked owner (explicit=%s)", (explicit) => {
  const raw = config({
    entries: { main: {}, ops: { default: true } },
    ...(explicit ? { ownership: "explicit" as const } : {}),
  });
  if (explicit) {
    expect(() => resolveAmbientOwnerAgentId(raw)).toThrow("no explicit owner");
  } else {
    expect(resolveAmbientOwnerAgentId(raw)).toBe("ops");
    expect(findLegacySystemAgentOwnerIssue(raw)).toBeUndefined();
  }
  const migrated: OpenClawConfig = migrate(raw).next ?? raw;
  expectOwner(migrated, "ops");
  if (!explicit) {
    expect(migrated.agents?.entries?.ops).not.toHaveProperty("default");
  }
});

it("preserves per-agent heartbeat enrollment", () => {
  const raw = config({ defaults: {}, entries: { main: {}, ops: { heartbeat: { every: "1h" } } } });
  expect(heartbeatIds(raw)).toEqual(["ops"]);
  const migrated: OpenClawConfig = migrate(raw).next ?? {};
  expect(migrated.agents?.defaults?.systemAgent?.agentId).toBe("main");
  expect(migrated).not.toHaveProperty("agents.defaults.heartbeat");
  expect(heartbeatIds(migrated)).toEqual(["ops"]);
});

it("stamps ownership without selecting an ambient owner", () => {
  const raw = config({ entries: { ops: {}, worker: {} } });
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
