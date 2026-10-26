import { afterEach, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import {
  invalidateSessionAutomationIndex,
  registerSessionAutomationSource,
  sessionHasAutomation,
} from "./session-automation-index.js";

const cfg: OpenClawConfig = {};
const subscriptions: (() => void)[] = [];
function watchChanges() {
  const changes: unknown[] = [];
  subscriptions.push(sessionChanges.subscribe((change) => changes.push(change)));
  return (...keys: (string | readonly [string, string])[]) => {
    expect(changes.splice(0)).toEqual(
      keys.map((key) =>
        typeof key === "string"
          ? { scope: "automation", sessionKey: key }
          : { scope: "automation", sessionKey: key[0], agentId: key[1] },
      ),
    );
  };
}
function registerJobs(jobs?: CronJob[]) {
  const source = { jobs, defaultAgentId: "main" };
  registerSessionAutomationSource({
    getJobs: () => source.jobs,
    getDefaultAgentId: () => source.defaultAgentId,
  });
  return source;
}

function job(partial: Partial<CronJob> & Pick<CronJob, "id">): CronJob {
  return { enabled: true, sessionTarget: "isolated", ...partial } as CronJob;
}

afterEach(() => {
  subscriptions.splice(0).forEach((stop) => stop());
  registerSessionAutomationSource(null);
});

test("unchanged bindings publish nothing, including shared bindings and in-place edits", () => {
  const first = job({ id: "a", sessionTarget: "main" });
  const second = job({ id: "b", sessionTarget: "main" });
  const jobs = [first, second];
  registerJobs(jobs);
  expect(sessionHasAutomation("agent:main:main", cfg)).toBe(true);
  const expectChanges = watchChanges();
  first.name = "renamed";
  invalidateSessionAutomationIndex();
  first.enabled = false;
  invalidateSessionAutomationIndex();
  jobs.shift();
  invalidateSessionAutomationIndex();
  expectChanges();
  second.enabled = false;
  invalidateSessionAutomationIndex();
  expectChanges("agent:main:main");
  expect(sessionHasAutomation("agent:main:main", cfg)).toBe(false);
});

test("publishes additions, removals, retargets, and mutable routing config deltas", () => {
  const config: OpenClawConfig = { session: { mainKey: "first" } };
  const source = registerJobs();
  expect(sessionHasAutomation("agent:main:first", config)).toBe(false);
  const expectChanges = watchChanges();
  const publish = (...keys: Parameters<typeof expectChanges>) => {
    invalidateSessionAutomationIndex();
    expectChanges(...keys);
  };
  const binding = job({ id: "a", sessionTarget: "main" });
  source.jobs = [binding];
  publish("agent:main:first");
  config.session!.mainKey = "second";
  publish("agent:main:first", "agent:main:second");
  source.defaultAgentId = "work";
  publish("agent:main:second", "agent:work:second");
  binding.sessionTarget = "session:agent:work:target";
  publish("agent:work:second", "agent:work:target");
  source.jobs = [];
  publish("agent:work:target");
  const global = job({ id: "global", sessionTarget: "main" });
  source.jobs = [global];
  config.session!.scope = "global";
  publish(["global", "work"]);
  expect(sessionHasAutomation("global", config, "work")).toBe(true);
  expect(sessionHasAutomation("global", config, "main")).toBe(false);
  global.enabled = false;
  publish(["global", "work"]);
});

test("reads adopt replacement config and default agents without replacing jobs", () => {
  const source = registerJobs([job({ id: "a", sessionTarget: "main" })]);
  expect(sessionHasAutomation("agent:main:main", cfg)).toBe(true);
  source.defaultAgentId = "work";
  expect(sessionHasAutomation("agent:work:main", cfg)).toBe(true);
  expect(sessionHasAutomation("agent:main:main", cfg)).toBe(false);
  const next: OpenClawConfig = { session: { mainKey: "next" } };
  expect(sessionHasAutomation("agent:work:next", next)).toBe(true);
  expect(sessionHasAutomation("agent:work:main", next)).toBe(false);
});

test("reads during array replacement do not consume the pending owner delta", () => {
  const source = registerJobs([job({ id: "a" })]);
  expect(sessionHasAutomation("agent:main:cron:a", cfg)).toBe(true);
  const expectChanges = watchChanges();
  source.jobs = [];
  expect(sessionHasAutomation("agent:main:unrelated", cfg)).toBe(false);
  expectChanges();
  invalidateSessionAutomationIndex();
  expectChanges("agent:main:cron:a");
});
