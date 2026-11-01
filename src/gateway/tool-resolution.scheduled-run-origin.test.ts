import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestAdmittedRunContext } from "../agents/admitted-run-context.test-support.js";
import type { createOpenClawTools } from "../agents/openclaw-tools.js";
import { assembleScheduledAdmissionFacts } from "../cron/execution-context-admission.js";
import { bindScheduledExecutionContext } from "../cron/execution-context-registry.js";
import { buildScheduledExecutionContext } from "../cron/execution-context.js";
import type { CronStoredJob } from "../cron/types.js";

const createTools = vi.hoisted(() =>
  vi.fn((_args: Parameters<typeof createOpenClawTools>[0]): unknown[] => []),
);

// mock-isolation: Resolve the Gateway tool scope without building the OpenClaw tools.
vi.mock("../agents/openclaw-tools.js", () => ({
  createOpenClawToolsAsync: async (...args: Parameters<typeof createTools>) => createTools(...args),
}));

import { resolveGatewayScopedTools } from "./tool-resolution.js";

const run = "agent:main:cron:nightly:run:r1";
const job = {
  id: "nightly",
  agentId: "main",
  name: "Nightly",
  enabled: true,
  createdAtMs: 0,
  updatedAtMs: 0,
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "do work" },
  delivery: { mode: "none" },
  state: {},
} as CronStoredJob;

describe("resolveGatewayScopedTools scheduled run origin", () => {
  beforeEach(() => {
    createTools.mockClear();
  });

  it.each([
    { kind: "the run's own turn", fresh: run, stamp: run },
    { kind: "another turn on the run's session", fresh: undefined, stamp: undefined },
  ])("stamps the origin its sub-agents inherit only for $kind", async ({ fresh, stamp }) => {
    const facts = assembleScheduledAdmissionFacts(
      {
        cfg: {},
        job,
        trigger: "cron",
        runId: "run-1",
        agentId: "main",
        runSessionKey: run,
        freshRunSessionKey: fresh,
      },
      undefined,
      true,
    );
    const built = buildScheduledExecutionContext(job, facts);
    if (built.status !== "ready") {
      throw new Error(`scheduled context not ready: ${built.status}`);
    }
    const admittedRunContext = createTestAdmittedRunContext("run-1");
    const unbind = bindScheduledExecutionContext(admittedRunContext.operationalRunInstance, {
      ...built.facts,
      assertCurrent: () => undefined,
    });
    let resolved: Awaited<ReturnType<typeof resolveGatewayScopedTools>>;
    try {
      resolved = await resolveGatewayScopedTools({
        cfg: {},
        sessionKey: run,
        surface: "loopback",
        requesterOrigin: { sessionKey: run },
        scheduledToolPolicy: { version: 1, mode: "trusted" },
        admittedRunContext,
      });
    } finally {
      unbind();
    }

    expect(resolved.requesterOrigin?.sessionKey).toBe(run);
    expect(resolved.requesterOrigin?.scheduledRunSessionKey).toBe(stamp);
  });
});
