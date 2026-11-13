// Proves each "armed background work" source against the real registry it
// reads, not a mock of the seam under test: the real subagent-registry
// live-run map cross-checked against the real agent-run-registry liveness
// state, and the real cron session-binding resolver. Only the cron *service*
// itself is a minimal fake satisfying the exact narrow contract
// (`list`/`getDefaultAgentId`) the production wiring consumes -- there is
// no in-process singleton cron service to drive here.
import { afterEach, describe, expect, it } from "vitest";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import { createMockGatewayLifecycleRuntime } from "../gateway/server-lifecycle-runtime.test-support.js";
import { createContext } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-context-binding.js";
import { claimAgentRunContext, resetAgentRunRegistryForTest } from "./agent-run-registry.js";
import {
  listArmedCronWakeSessionKeys,
  listArmedSubagentWaitSessionKeys,
} from "./background-activity-sources.js";

describe("listArmedSubagentWaitSessionKeys", () => {
  afterEach(() => {
    subagentRuns.clear();
    resetAgentRunRegistryForTest();
  });

  function fakeRun(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
    return {
      runId: overrides.runId ?? "run-live",
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:requester",
      requesterDisplayKey: "agent:main:requester",
      task: "background proof task",
      cleanup: "keep",
      createdAt: Date.now(),
      execution: { status: "running" },
      expectsCompletionMessage: true,
      ...overrides,
    } as SubagentRunRecord;
  }

  it("includes the requester session for a genuinely live, currently-tracked run", () => {
    const entry = fakeRun({ runId: "run-live", requesterSessionKey: "agent:main:live-requester" });
    subagentRuns.set(entry.runId, entry);
    // Real, currently-tracked gateway-side registration -- not a bare in-memory claim.
    claimAgentRunContext(entry.runId, {}, { trackOwner: true });

    expect(listArmedSubagentWaitSessionKeys()).toContain("agent:main:live-requester");
  });

  it("excludes an unended run with no live agent-run-registry registration (the hollow-wait case)", () => {
    const entry = fakeRun({
      runId: "run-hollow",
      requesterSessionKey: "agent:main:hollow-requester",
    });
    subagentRuns.set(entry.runId, entry);
    // Deliberately no claimAgentRunContext call: the run claims to still be
    // executing (`execution.endedAt` unset) but nothing real backs it.

    expect(listArmedSubagentWaitSessionKeys()).not.toContain("agent:main:hollow-requester");
  });

  it("excludes a run whose execution has already ended even if still claimed live", () => {
    const entry = fakeRun({
      runId: "run-ended",
      requesterSessionKey: "agent:main:ended-requester",
      execution: { status: "terminal", endedAt: Date.now() },
    });
    subagentRuns.set(entry.runId, entry);
    claimAgentRunContext(entry.runId, {}, { trackOwner: true });

    expect(listArmedSubagentWaitSessionKeys()).not.toContain("agent:main:ended-requester");
  });

  it("excludes a live run that owes its requester no completion", () => {
    // A plugin child registered without a requester is filed under the owner
    // main session with expectsCompletionMessage: false; nothing returns there.
    const entry = fakeRun({
      runId: "run-quiet",
      requesterSessionKey: "agent:main:quiet-requester",
      expectsCompletionMessage: false,
    });
    subagentRuns.set(entry.runId, entry);
    claimAgentRunContext(entry.runId, {}, { trackOwner: true });

    expect(listArmedSubagentWaitSessionKeys()).not.toContain("agent:main:quiet-requester");
  });

  it("leaves a run to detached lifecycle typing when that already owns its signal", () => {
    const owned = {
      requesterOrigin: { channel: "telegram", to: "-100123" },
      completionRequesterSessionId: "parent-session",
      requesterAgentId: "main",
      requesterStorePath: "/tmp/sessions.json",
    } satisfies Partial<SubagentRunRecord>;
    const lifecycleTyped = fakeRun({
      ...owned,
      runId: "run-lifecycle-typed",
      requesterSessionKey: "agent:main:telegram:owned",
    });
    // Same record shape, but no gateway runtime offering startTyping: lifecycle
    // typing cannot own it, so the indicator still does.
    const unowned = fakeRun({
      ...owned,
      runId: "run-unowned",
      requesterSessionKey: "agent:main:telegram:unowned",
    });
    const context = createContext();
    context.lifecycleRuntime = createMockGatewayLifecycleRuntime({ startTyping: () => () => {} });
    bindGatewayContextResolver(lifecycleTyped, () => context);
    for (const entry of [lifecycleTyped, unowned]) {
      subagentRuns.set(entry.runId, entry);
      claimAgentRunContext(entry.runId, {}, { trackOwner: true });
    }

    const keys = listArmedSubagentWaitSessionKeys();
    expect(keys).not.toContain("agent:main:telegram:owned");
    expect(keys).toContain("agent:main:telegram:unowned");
  });
});

describe("listArmedCronWakeSessionKeys", () => {
  const cfg = {} as OpenClawConfig;

  function fakeJob(overrides: Partial<CronJob> & Pick<CronJob, "id">): CronJob {
    return {
      agentId: "main",
      name: overrides.id,
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
      ...overrides,
    } as unknown as CronJob;
  }

  function fakeCron(jobs: CronJob[]) {
    return {
      list: async () => jobs,
      getDefaultAgentId: () => "main",
    };
  }

  it("includes a session bound to an enabled job with an imminent fire", async () => {
    const now = Date.parse("2026-09-17T00:00:00Z");
    const job = fakeJob({
      id: "armed-job",
      agentId: "cronowner",
      sessionTarget: "main",
      state: { nextRunAtMs: now + 60_000 },
    });
    const keys = await listArmedCronWakeSessionKeys({ cron: fakeCron([job]), cfg, now });
    expect(keys).toContain("agent:cronowner:main");
  });

  it("excludes a job with no scheduled next fire", async () => {
    const now = Date.parse("2026-09-17T00:00:00Z");
    const job = fakeJob({
      id: "unarmed-job",
      agentId: "cronowner2",
      sessionTarget: "main",
      state: {},
    });
    const keys = await listArmedCronWakeSessionKeys({ cron: fakeCron([job]), cfg, now });
    expect(keys).not.toContain("agent:cronowner2:main");
  });

  it("excludes a job whose next fire is well in the past (stale/stuck, not merely lagging)", async () => {
    const now = Date.parse("2026-09-17T00:00:00Z");
    const job = fakeJob({
      id: "stale-job",
      agentId: "cronowner3",
      sessionTarget: "main",
      state: { nextRunAtMs: now - 5 * 60_000 },
    });
    const keys = await listArmedCronWakeSessionKeys({ cron: fakeCron([job]), cfg, now });
    expect(keys).not.toContain("agent:cronowner3:main");
  });

  it("excludes a daily job between fires and includes it again while it runs", async () => {
    const now = Date.parse("2026-09-17T00:00:00Z");
    const nextRunAtMs = now + 6 * 60 * 60_000;
    const idle = fakeJob({ id: "daily-idle", agentId: "daily", state: { nextRunAtMs } });
    const running = fakeJob({
      id: "daily-running",
      agentId: "dailyrun",
      state: { nextRunAtMs, runningAtMs: now - 5 * 60_000 },
    });
    const keys = await listArmedCronWakeSessionKeys({ cron: fakeCron([idle, running]), cfg, now });
    expect(keys).not.toContain("agent:daily:main");
    expect(keys).toContain("agent:dailyrun:main");
  });
});
