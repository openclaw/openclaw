import { afterEach, describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  invalidateSessionAutomationIndex,
  claimSessionAutomationEpoch,
  registerSessionAutomationSource,
  sessionHasAutomation,
  unregisterSessionAutomationSource,
} from "./session-automation-index.js";

const cfg = {} as OpenClawConfig;

function job(partial: Partial<CronJob> & Pick<CronJob, "id">): CronJob {
  return { enabled: true, sessionTarget: "isolated", ...partial } as CronJob;
}

afterEach(() => {
  registerSessionAutomationSource(null);
});

describe("session automation index", () => {
  test("reports sessions bound to enabled jobs", () => {
    const jobs = [job({ id: "a" }), job({ id: "b", enabled: false })];
    registerSessionAutomationSource({
      getJobs: () => jobs,
      getDefaultAgentId: () => "main",
    });
    expect(sessionHasAutomation("agent:main:cron:a", cfg)).toBe(true);
    expect(sessionHasAutomation("agent:main:cron:b", cfg)).toBe(false);
    expect(sessionHasAutomation("agent:main:main", cfg)).toBe(false);
  });

  test("unchanged bindings publish nothing, including shared bindings and in-place edits", () => {
    const first = job({ id: "a", sessionTarget: "main" });
    const second = job({ id: "b", sessionTarget: "main" });
    const jobs = [first, second];
    registerSessionAutomationSource({ getJobs: () => jobs, getDefaultAgentId: () => "main" });
    expect(sessionHasAutomation("agent:main:main", cfg)).toBe(true);
    const changed = vi.fn();
    const stop = sessionChanges.subscribe(changed);
    try {
      first.name = "renamed";
      invalidateSessionAutomationIndex();
      first.enabled = false;
      invalidateSessionAutomationIndex();
      jobs.shift();
      invalidateSessionAutomationIndex();
      expect(changed).not.toHaveBeenCalled();
      second.enabled = false;
      invalidateSessionAutomationIndex();
      expect(changed).toHaveBeenCalledExactlyOnceWith({
        sessionKey: "agent:main:main",
        scope: "automation",
      });
      expect(sessionHasAutomation("agent:main:main", cfg)).toBe(false);
    } finally {
      stop();
    }
  });

  test("owner publications invalidate the memo after in-place job mutations", () => {
    const jobs = [job({ id: "a" })];
    registerSessionAutomationSource({
      getJobs: () => jobs,
      getDefaultAgentId: () => "main",
    });
    expect(sessionHasAutomation("agent:main:cron:a", cfg)).toBe(true);
    (jobs[0] as { enabled: boolean }).enabled = false;
    invalidateSessionAutomationIndex();
    expect(sessionHasAutomation("agent:main:cron:a", cfg)).toBe(false);
  });

  test("unregistering the source clears automation state", () => {
    registerSessionAutomationSource({
      getJobs: () => [job({ id: "a" })],
      getDefaultAgentId: () => "main",
    });
    expect(sessionHasAutomation("agent:main:cron:a", cfg)).toBe(true);
    registerSessionAutomationSource(null);
    expect(sessionHasAutomation("agent:main:cron:a", cfg)).toBe(false);
  });

  test("reports false before the cron store is loaded", () => {
    registerSessionAutomationSource({
      getJobs: () => undefined,
      getDefaultAgentId: () => "main",
    });
    expect(sessionHasAutomation("agent:main:cron:a", cfg)).toBe(false);
  });

  test("publishes additions, removals, retargets, and mutable routing config deltas", () => {
    const config: OpenClawConfig = { session: { mainKey: "first" } };
    let jobs: CronJob[] | undefined;
    let defaultAgentId = "main";
    registerSessionAutomationSource({
      getJobs: () => jobs,
      getDefaultAgentId: () => defaultAgentId,
    });
    expect(sessionHasAutomation("agent:main:first", config)).toBe(false);
    const changes: unknown[] = [];
    const stop = sessionChanges.subscribe((change) => changes.push(change));
    const take = () => changes.splice(0);
    const change = (sessionKey: string, agentId?: string) => ({
      sessionKey,
      scope: "automation",
      ...(agentId ? { agentId } : {}),
    });
    try {
      const binding = job({ id: "a", sessionTarget: "main" });
      jobs = [binding];
      invalidateSessionAutomationIndex();
      expect(take()).toEqual([change("agent:main:first")]);
      config.session!.mainKey = "second";
      invalidateSessionAutomationIndex();
      expect(take()).toEqual([change("agent:main:first"), change("agent:main:second")]);
      defaultAgentId = "work";
      invalidateSessionAutomationIndex();
      expect(take()).toEqual([change("agent:main:second"), change("agent:work:second")]);
      binding.sessionTarget = "session:agent:work:target";
      invalidateSessionAutomationIndex();
      expect(take()).toEqual([change("agent:work:second"), change("agent:work:target")]);
      jobs = [];
      invalidateSessionAutomationIndex();
      expect(take()).toEqual([change("agent:work:target")]);
      const global = job({ id: "global", sessionTarget: "main" });
      jobs = [global];
      config.session!.scope = "global";
      invalidateSessionAutomationIndex();
      expect(take()).toEqual([change("global", "work")]);
      expect(sessionHasAutomation("global", config, "work")).toBe(true);
      expect(sessionHasAutomation("global", config, "main")).toBe(false);
      global.enabled = false;
      invalidateSessionAutomationIndex();
      expect(take()).toEqual([change("global", "work")]);
    } finally {
      stop();
    }
  });

  test("reads adopt replacement config and default agents without replacing jobs", () => {
    const jobs = [job({ id: "a", sessionTarget: "main" })];
    let defaultAgentId = "main";
    registerSessionAutomationSource({
      getJobs: () => jobs,
      getDefaultAgentId: () => defaultAgentId,
    });
    expect(sessionHasAutomation("agent:main:main", cfg)).toBe(true);
    defaultAgentId = "work";
    expect(sessionHasAutomation("agent:work:main", cfg)).toBe(true);
    expect(sessionHasAutomation("agent:main:main", cfg)).toBe(false);
    const next: OpenClawConfig = { session: { mainKey: "next" } };
    expect(sessionHasAutomation("agent:work:next", next)).toBe(true);
    expect(sessionHasAutomation("agent:work:main", next)).toBe(false);
  });

  test("reads during array replacement do not consume the pending owner delta", () => {
    let jobs = [job({ id: "a" })];
    registerSessionAutomationSource({ getJobs: () => jobs, getDefaultAgentId: () => "main" });
    expect(sessionHasAutomation("agent:main:cron:a", cfg)).toBe(true);
    const changed = vi.fn();
    const stop = sessionChanges.subscribe(changed);
    try {
      // Removal replaces the array before persistence yields to another reader.
      jobs = [];
      expect(sessionHasAutomation("agent:main:unrelated", cfg)).toBe(false);
      expect(changed).not.toHaveBeenCalled();
      invalidateSessionAutomationIndex();
      expect(changed).toHaveBeenCalledExactlyOnceWith({
        sessionKey: "agent:main:cron:a",
        scope: "automation",
      });
    } finally {
      stop();
    }
  });

  test("stale services cannot clobber or clear a replacement registration", () => {
    expect(sessionHasAutomation("agent:main:cron:fresh", cfg)).toBe(false);
    const changes: unknown[] = [];
    const unsubscribe = sessionChanges.subscribe((change) => changes.push(change));
    try {
      const staleEpoch = claimSessionAutomationEpoch();
      const staleSource = {
        getJobs: () => [job({ id: "stale" })],
        getDefaultAgentId: () => "main",
      };
      const freshEpoch = claimSessionAutomationEpoch();
      const freshSource = {
        getJobs: () => [job({ id: "fresh" })],
        getDefaultAgentId: () => "main",
      };
      registerSessionAutomationSource(freshSource, freshEpoch);
      // Config-reload race: the older service's start resolves late.
      registerSessionAutomationSource(staleSource, staleEpoch);
      expect(sessionHasAutomation("agent:main:cron:fresh", cfg)).toBe(true);
      expect(sessionHasAutomation("agent:main:cron:stale", cfg)).toBe(false);
      unregisterSessionAutomationSource(staleSource);
      expect(sessionHasAutomation("agent:main:cron:fresh", cfg)).toBe(true);
      unregisterSessionAutomationSource(freshSource);
      expect(sessionHasAutomation("agent:main:cron:fresh", cfg)).toBe(false);
      invalidateSessionAutomationIndex();
      expect(changes).toEqual([
        { sessionKey: "agent:main:cron:fresh", scope: "automation" },
        { sessionKey: "agent:main:cron:fresh", scope: "automation" },
      ]);
    } finally {
      unsubscribe();
    }
  });
});
