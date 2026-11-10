import fs from "node:fs";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { describeHeartbeatSessionTargetIssues } from "./doctor-heartbeat-session-target.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-heartbeat-doctor-");

function cfgWithSession(
  session: string,
  heartbeat: AgentDefaultsConfig["heartbeat"] = { target: "slack" },
  sqlite = false,
): OpenClawConfig {
  const file = sqlite ? "sessions.sqlite" : "sessions.json";
  return {
    session: {
      mainKey: "work",
      store: path.join(sessionDirs.make(), "{agentId}", file),
    },
    agents: { entries: { ops: { heartbeat: { session, ...heartbeat } } } },
  };
}

function writeStore(cfg: OpenClawConfig, entries: Record<string, unknown>) {
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "ops" });
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(entries, null, 2));
}

it.each([
  ["agent:ops:main", "agent:ops:work", false],
  ["agent:ops:dashboard:incognito-heartbeat", "agent:ops:dashboard:incognito-heartbeat", true],
] as const)("resolves legacy target %s", async (session, storedKey, missing) => {
  const cfg = cfgWithSession(session);
  writeStore(cfg, { [storedKey]: { sessionId: "legacy", updatedAt: 1 } });
  expect(await describeHeartbeatSessionTargetIssues(cfg)).toEqual(
    missing ? [expect.stringContaining(`resolved to ${session}`)] : [],
  );
});

it("does not read a canonical database as JSON for a missing heartbeat target", async () => {
  const cfg = cfgWithSession("slack:channel:c123", undefined, true);
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "ops" });
  await upsertSessionEntryCore(
    { agentId: "ops", sessionKey: "agent:ops:other", storePath },
    { sessionId: "other-session", updatedAt: Date.now() },
  );
  using readFileSyncSpy = vi.spyOn(fs, "readFileSync");

  const warnings = await describeHeartbeatSessionTargetIssues(cfg);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("resolved to agent:ops:slack:channel:c123");
  expect(warnings[0]).toContain("missing session route or recipient");
  expect(readFileSyncSpy.mock.calls.map(([file]) => file)).not.toContain(storePath);
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
  expect(await describeHeartbeatSessionTargetIssues(cfg)).toEqual(
    ["main", "ops"].map((id) =>
      expect.stringContaining(
        `Agent ${id} heartbeat.session pins slack:channel:c123 (resolved to agent:${id}:slack:channel:c123)`,
      ),
    ),
  );
});

it("warns when the default owner target has no configured owner route", async () => {
  const cfg = cfgWithSession("slack:channel:c123", {});
  const warning = (await describeHeartbeatSessionTargetIssues(cfg))[0];
  expect(warning).toContain("missing owner route");
  expect(warning).toContain('commands.ownerAllowFrom=["telegram:123456789"]');
  expect(warning).toMatch(
    /heartbeat.target="telegram".*heartbeat.to="123456789".*heartbeat.target="none"/,
  );
});
