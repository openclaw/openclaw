import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { describeHeartbeatSessionTargetIssues } from "./doctor-heartbeat-session-target.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-heartbeat-doctor-");

let tmpDir: string;

beforeEach(() => {
  tmpDir = sessionDirs.make();
});

function cfgWithSession(
  session: string,
  heartbeat: AgentDefaultsConfig["heartbeat"] = { target: "slack" },
): OpenClawConfig {
  return {
    session: {
      mainKey: "work",
      store: path.join(tmpDir, "agents", "{agentId}", "sessions", "sessions.json"),
    },
    agents: { entries: { ops: { heartbeat: { session, ...heartbeat } } } },
  };
}

function writeStore(cfg: OpenClawConfig, entries: Record<string, unknown>) {
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "ops" });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(entries, null, 2));
}

it("uses runtime session canonicalization before warning", async () => {
  const cfg = cfgWithSession("agent:ops:main");
  writeStore(cfg, { "agent:ops:work": { sessionId: "work", updatedAt: 1 } });

  expect(await describeHeartbeatSessionTargetIssues(cfg)).toEqual([]);
});

it("does not read a canonical database as JSON for a missing heartbeat target", async () => {
  const cfg = cfgWithSession("slack:channel:c123");
  const storePath = path.join(tmpDir, "sessions.sqlite");
  cfg.session = { ...cfg.session, store: storePath };
  await upsertSessionEntryCore(
    { agentId: "ops", sessionKey: "agent:ops:other", storePath },
    { sessionId: "other-session", updatedAt: Date.now() },
  );
  using readFileSyncSpy = vi.spyOn(fs, "readFileSync");

  const warnings = await describeHeartbeatSessionTargetIssues(cfg);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("resolved to agent:ops:slack:channel:c123");
  expect(warnings[0]).toContain("missing session route or recipient");
  expect(warnings[0]).toContain("delivery failure instead of skipping the run");
  expect(readFileSyncSpy.mock.calls.map(([file]) => file)).not.toContain(storePath);
});

it("does not recover an absent incognito heartbeat target from a legacy store", async () => {
  const sessionKey = "agent:ops:dashboard:incognito-heartbeat";
  const cfg = cfgWithSession(sessionKey);
  writeStore(cfg, { [sessionKey]: { sessionId: "legacy", updatedAt: 1 } });

  const warnings = await describeHeartbeatSessionTargetIssues(cfg);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(`resolved to ${sessionKey}`);
  expect(warnings[0]).toContain("has no entry");
});

it.each([
  { target: "telegram", to: "-100123" },
  { target: "slack", every: "0m" },
])("does not require session history for %j", async (heartbeat) => {
  const cfg = cfgWithSession("slack:channel:c123", heartbeat);
  expect(await describeHeartbeatSessionTargetIssues(cfg)).toEqual([]);
});

it("warns for missing sessions owned by every agent sharing heartbeat defaults", async () => {
  const cfg = cfgWithSession("slack:channel:c123");
  cfg.agents = {
    defaults: { heartbeat: { session: "slack:channel:c123", target: "slack" } },
    entries: { main: {}, ops: {} },
  };
  writeStore(cfg, {});

  const warnings = await describeHeartbeatSessionTargetIssues(cfg);

  expect(warnings).toHaveLength(2);
  for (const [index, agentId] of ["main", "ops"].entries()) {
    expect(warnings[index]).toContain(`Agent ${agentId} heartbeat.session pins slack:channel:c123`);
    expect(warnings[index]).toContain(`resolved to agent:${agentId}:slack:channel:c123`);
  }
});

it("warns when the default owner target has no configured owner route", async () => {
  const cfg = cfgWithSession("slack:channel:c123", {});
  writeStore(cfg, {});

  const warning = (await describeHeartbeatSessionTargetIssues(cfg))[0];
  expect(warning).toContain("missing owner route can cause a delivery failure");
  expect(warning).toContain('commands.ownerAllowFrom=["telegram:123456789"]');
  expect(warning).toContain('heartbeat.target="telegram"');
  expect(warning).toContain('heartbeat.to="123456789"');
  expect(warning).toContain('heartbeat.target="none"');
});
