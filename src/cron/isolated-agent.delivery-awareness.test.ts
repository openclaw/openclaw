import "./isolated-agent.mocks.js";
import assert from "node:assert/strict";
import path from "node:path";
import { beforeAll, beforeEach, expect, it, type Mock } from "vitest";
import type { ReplyPayload } from "../auto-reply/types.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStoreEntries,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";
import { cronRunEntryMatchesLink } from "./run-link.js";
import { TEST_SCHEDULED_OCCURRENCE } from "./scheduled-occurrence.test-support.js";
import type { CronJob } from "./types.js";

async function announce(
  payloads: ReplyPayload[],
  options: {
    gateway?: NonNullable<Parameters<typeof makeCfg>[2]>["gateway"];
    entries?: Record<string, SessionEntry>;
    delivery?: { mode: "announce"; channel: "last" | "telegram"; to?: string };
    job?: Partial<CronJob>;
  } = {},
) {
  return withTempCronHome(async (home) => {
    const storePath = path.join(home, ".openclaw", "sessions", "sessions.json");
    const cfg = makeCfg(home, storePath, options.gateway ? { gateway: options.gateway } : {});
    setRuntimeConfigSnapshot(cfg);
    await writeSessionStoreEntries(home, options.entries ?? {});
    const deps = createCliDeps();
    mockAgentPayloads(payloads);
    const result = await runCronIsolatedAgentTurn({
      occurrence: TEST_SCHEDULED_OCCURRENCE,
      deliveryAttemptFence: null,
      cfg,
      deps,
      job: {
        ...makeJob({ kind: "agentTurn", message: "do it" }),
        delivery: options.delivery ?? { mode: "announce", channel: "telegram", to: "123" },
        ...options.job,
      },
      message: "do it",
      sessionKey: "cron:job-1",
      lane: "cron",
    });
    return { result, deps };
  });
}

function reset() {
  setupIsolatedAgentTurnMocks();
  resetSystemEventsForTest();
}
beforeAll(async () => {
  reset();
  await announce([{ text: "warm runtime" }]);
});
beforeEach(reset);

const RUN_STARTED_AT_MS = 1_700_000_000_000;
const CONTROL_UI_GATEWAY = {
  publicOrigin: "https://control.example",
  controlUi: { basePath: "/console" },
};

function claimedRun(runningAtMs: number): Partial<CronJob> {
  return { state: { runningAtMs } };
}

function sessionLink(sessionKey: unknown) {
  assert(typeof sessionKey === "string", "expected a cron run session key");
  return `https://control.example/console/chat/main/${sessionKey.replace(/^agent:main:/, "").replaceAll(":", "/")}`;
}

function lastTelegramText(deps: ReturnType<typeof createCliDeps>) {
  return String((deps.telegram as unknown as Mock).mock.lastCall?.[1]);
}

it("links the final visible payload to the recorded automation run", async () => {
  const { result, deps } = await announce(
    [
      { text: "first cron update", mediaUrl: "https://example.com/report.png" },
      { text: "final cron summary" },
    ],
    { gateway: CONTROL_UI_GATEWAY, job: claimedRun(RUN_STARTED_AT_MS) },
  );
  expect(result).toMatchObject({ status: "ok", delivered: true });
  expect(result.sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
  const finalText = `final cron summary\n[Inspect run](https://control.example/console/automations?job=job-1&run=cron%3Ajob-1%3A${RUN_STARTED_AT_MS})`;
  expect(deps.telegram).toHaveBeenNthCalledWith(1, "123", "first cron update", expect.any(Object));
  expect(deps.telegram).toHaveBeenNthCalledWith(2, "123", finalText, expect.any(Object));
  expect(deps.telegram).toHaveBeenCalledTimes(2);
  expect(peekSystemEvents("agent:main:main")).toEqual([]);
  expect(peekSystemEvents("agent:main:global")).toEqual([]);
  expect(peekSystemEventEntries("agent:other:global")).toEqual([]);
});

it("links each execution of a job to its own recorded run, not its transient session", async () => {
  const runs = [RUN_STARTED_AT_MS, RUN_STARTED_AT_MS + 60_000];
  const links: string[] = [];
  for (const runningAtMs of runs) {
    const { result, deps } = await announce([{ text: "digest" }], {
      gateway: CONTROL_UI_GATEWAY,
      job: claimedRun(runningAtMs),
    });
    const link = /\]\((.+)\)$/.exec(lastTelegramText(deps))?.[1];
    assert(link, "expected an inspection link");
    assert(typeof result.sessionKey === "string", "expected a cron run session key");
    expect(link).not.toContain(result.sessionKey);
    const runId = new URL(link).searchParams.get("run");
    assert(runId, "expected a run selector");
    for (const candidate of runs) {
      expect(cronRunEntryMatchesLink(runId, { jobId: "job-1", runAtMs: candidate })).toBe(
        candidate === runningAtMs,
      );
    }
    links.push(link);
  }
  expect(new Set(links).size).toBe(runs.length);
});

it.each([
  // Hook, plugin and channel-join jobs are never persisted and are never claimed by the scheduler.
  [
    "a synthetic hook job",
    {
      schedule: { kind: "at", at: new Date().toISOString() },
      state: { nextRunAtMs: Date.now() },
    },
  ],
  ["a job without state", { state: undefined } as unknown as Partial<CronJob>],
] satisfies [string, Partial<CronJob>][])(
  "keeps the run session link for %s",
  async (_name, job) => {
    const { result, deps } = await announce([{ text: "digest" }], {
      gateway: CONTROL_UI_GATEWAY,
      job,
    });
    expect(result).toMatchObject({ status: "ok", delivered: true });
    expect(lastTelegramText(deps)).toBe(`digest\n[Inspect run](${sessionLink(result.sessionKey)})`);
  },
);

it.each([
  ["no public origin", {}],
  [
    "Control UI disabled",
    { publicOrigin: "https://control.example", controlUi: { enabled: false } },
  ],
])("omits the inspection link when %s", async (_name, gateway) => {
  const { deps } = await announce([{ text: "digest" }], {
    gateway,
    job: claimedRun(RUN_STARTED_AT_MS),
  });
  expect(lastTelegramText(deps)).toBe("digest");
});

it("does not turn a silent reply into an inspection-link announcement", async () => {
  const { result, deps } = await announce([{ text: "NO_REPLY" }], {
    gateway: { publicOrigin: "https://control.example" },
  });
  expect(result.status).toBe("ok");
  expect(result.delivered).toBeFalsy();
  expect(deps.telegram).not.toHaveBeenCalled();
});

it("refuses keyless delivery inherited from another conversation's shared main bucket", async () => {
  // #91613: main.lastTo belongs to whichever conversation last wrote the shared bucket.
  const { result, deps } = await announce([{ text: "implicit cron digest" }], {
    delivery: { mode: "announce", channel: "last" },
    entries: {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now(),
        delivery: normalizeSessionDeliveryState({ context: { channel: "telegram", to: "123" } }),
      },
    },
  });
  expect(result).toMatchObject({ status: "ok", delivered: false });
  expect(result.error).toBeUndefined();
  expect(result.deliveryState?.status).toBe("not-delivered");
  expect(result.deliveryError).toContain("shared agent-main session bucket");
  expect(deps.telegram).not.toHaveBeenCalled();
  expect(peekSystemEvents("agent:main:main")).toStrictEqual([]);
});
