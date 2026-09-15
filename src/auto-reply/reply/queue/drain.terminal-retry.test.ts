import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../../runtime.js";
import { handleDirectiveOnly } from "../directive-handling.impl.js";
import { parseInlineSessionDirectives } from "../directive-handling.parse.js";
import * as directivePersistence from "../directive-handling.shared.js";
import {
  clearSessionQueues,
  enqueueFollowupRun,
  FollowupRunDeferredError,
  scheduleFollowupDrain,
} from "../queue.js";
import { createQueueTestRun as createRun } from "../queue.test-helpers.js";
import { FOLLOWUP_QUEUES } from "./state.js";
import {
  admitFollowupRunLifecycle,
  completeFollowupRunLifecycle,
  type FollowupRun,
  type QueueSettings,
} from "./types.js";

const SETTINGS: QueueSettings = { mode: "followup", debounceMs: 0, cap: 50 };
const CAP = 7;
let key: string;
let nextKey = 0;

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function finish(): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    await vi.runAllTimersAsync();
    await sleep(2);
    if (!FOLLOWUP_QUEUES.get(key)?.draining && vi.getTimerCount() === 0) {
      return;
    }
  }
  throw new Error("queue did not settle");
}

async function applyQueueDirective(body: string, authorized = true, storePath?: string) {
  const sessionEntry = {
    sessionId: "sess",
    updatedAt: Date.now(),
    queueMode: "followup" as const,
    queueCap: 50,
  };
  return handleDirectiveOnly({
    cfg: { messages: { queue: { mode: "followup", debounceMsByChannel: { slack: 0 } } } },
    agentId: "main",
    directives: parseInlineSessionDirectives(body),
    sessionEntry,
    sessionStore: { [key]: sessionEntry },
    sessionKey: key,
    storePath,
    messageProvider: "slack",
    commandAuthorized: authorized,
    senderIsOwner: false,
    elevatedEnabled: false,
    elevatedAllowed: false,
    defaultProvider: "openai",
    defaultModel: "gpt-test",
    aliasIndex: { byAlias: new Map(), byKey: new Map() },
    allowedModelKeys: new Set<string>(),
    allowedModelCatalog: [],
    resetModelOverride: false,
    provider: "openai",
    model: "gpt-test",
    initialModelLabel: "openai/gpt-test",
    formatModelSwitchEvent: (label) => label,
  });
}

describe("followup drain failure ownership", () => {
  let errors: string[];
  beforeEach(() => {
    key = `test-terminal-retry-${nextKey++}`;
    vi.useFakeTimers();
    errors = [];
    vi.spyOn(defaultRuntime, "error").mockImplementation((message: unknown) => {
      errors.push(String(message));
    });
  });
  afterEach(async () => {
    clearSessionQueues([key]);
    await finish();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("backs off and parks failed work without settling its lifecycle or consuming survivors", async () => {
    const settled = vi.fn();
    const failed = createRun({ prompt: "failed", messageId: "failed" });
    failed.turnAdoptionLifecycle = { onAdopted: vi.fn(), onSettled: settled };
    const attempts: number[] = [];
    const delivered: string[] = [];
    enqueueFollowupRun(key, failed, SETTINGS);
    enqueueFollowupRun(key, createRun({ prompt: "survivor", messageId: "survivor" }), SETTINGS);
    scheduleFollowupDrain(key, async (run) => {
      if (run.prompt === "failed") {
        attempts.push(Date.now());
        throw new Error("permanent producer defect");
      }
      delivered.push(run.prompt);
    });
    await flush();
    await finish();
    expect(attempts).toHaveLength(CAP);
    expect(
      attempts.slice(1).map((time, index) => {
        const previous = attempts[index];
        if (previous === undefined) {
          throw new Error("Missing previous drain attempt");
        }
        return time - previous;
      }),
    ).toEqual([500, 1000, 2000, 4000, 8000, 10000]);
    expect(delivered).toEqual([]);
    expect(settled).not.toHaveBeenCalled();
    expect(errors.filter((error) => error.includes("queue suspended"))).toHaveLength(1);
    expect(FOLLOWUP_QUEUES.get(key)?.items.map((run) => run.prompt)).toEqual([
      "failed",
      "survivor",
    ]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(attempts).toHaveLength(CAP);
    const replacement = vi.fn(async () => {});
    scheduleFollowupDrain(key, replacement);
    enqueueFollowupRun(key, createRun({ prompt: "new", messageId: "new" }), SETTINGS);
    await finish();
    expect(attempts).toHaveLength(CAP);
    expect(FOLLOWUP_QUEUES.get(key)?.items).toHaveLength(3);
    expect(replacement).not.toHaveBeenCalled();
  });

  it.each(["/queue reset", "/queue cap:51"])(
    "resumes retained work with a fresh budget after accepted %s",
    async (command) => {
      const settled = vi.fn();
      const source = createRun({ prompt: "retained", messageId: "retained" });
      source.turnAdoptionLifecycle = { onAdopted: vi.fn(), onSettled: settled };
      enqueueFollowupRun(key, source, SETTINGS);
      const queuedSource = FOLLOWUP_QUEUES.get(key)?.items[0];
      let attempts = 0;
      const delivered: FollowupRun[] = [];
      scheduleFollowupDrain(key, async (run) => {
        if (++attempts < CAP * 2) {
          throw new Error("temporary");
        }
        await admitFollowupRunLifecycle(run);
        delivered.push(run);
        completeFollowupRunLifecycle(run);
      });
      await finish();
      expect(attempts).toBe(CAP);
      expect(settled).not.toHaveBeenCalled();
      const response = await applyQueueDirective(command);
      expect(response?.text).toContain("Retained queued messages will retry.");
      await finish();
      expect(attempts).toBe(CAP * 2);
      expect(delivered).toEqual([queuedSource]);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(FOLLOWUP_QUEUES.has(key)).toBe(false);
    },
  );

  it.each([
    { command: "/queue reset", authorized: false },
    { command: "/queue", authorized: true },
    { command: "/queue followup", authorized: true },
    { command: "/queue cap:zero", authorized: true },
  ])(
    "does not resume for an unauthorized, status-only, unchanged, or invalid directive: $command ($authorized)",
    async ({ command, authorized }) => {
      const run = vi.fn(async () => {
        throw new Error("temporary");
      });
      enqueueFollowupRun(key, createRun({ prompt: "retained", messageId: "retained" }), SETTINGS);
      scheduleFollowupDrain(key, run);
      await finish();
      expect(run).toHaveBeenCalledTimes(CAP);
      const response = await applyQueueDirective(command, authorized);
      expect(response?.text).not.toContain("Retained queued messages will retry.");
      await finish();
      expect(run).toHaveBeenCalledTimes(CAP);
      expect(FOLLOWUP_QUEUES.get(key)?.items[0]?.prompt).toBe("retained");
    },
  );

  it("does not resume if the authorized queue directive loses its persistence transaction", async () => {
    const run = vi.fn(async () => {
      throw new Error("temporary");
    });
    enqueueFollowupRun(key, createRun({ prompt: "retained", messageId: "retained" }), SETTINGS);
    scheduleFollowupDrain(key, run);
    await finish();
    vi.spyOn(directivePersistence, "persistSessionDirectiveSnapshot").mockResolvedValue({
      status: "conflict",
    });
    const response = await applyQueueDirective(
      "/queue reset",
      true,
      "/unused/persistence-boundary",
    );
    expect(response?.text).toContain("Session settings were not applied");
    await finish();
    expect(run).toHaveBeenCalledTimes(CAP);
    expect(FOLLOWUP_QUEUES.get(key)?.items[0]?.prompt).toBe("retained");
  });

  it("does not treat a concurrent untouched setting update as an explicit retry request", async () => {
    const run = vi.fn(async () => {
      throw new Error("temporary");
    });
    enqueueFollowupRun(key, createRun({ prompt: "retained", messageId: "retained" }), SETTINGS);
    scheduleFollowupDrain(key, run);
    await finish();
    vi.spyOn(directivePersistence, "persistSessionDirectiveSnapshot").mockImplementation(
      async (params) => {
        params.sessionEntry.queueCap = 51;
        return { status: "applied" };
      },
    );
    await applyQueueDirective("/queue followup", true, "/unused/persistence-boundary");
    await finish();
    expect(run).toHaveBeenCalledTimes(CAP);
  });

  it.each(["in-flight", "suspended"])(
    "settles %s cancellation and releases the empty queue for fresh input",
    async (when) => {
      const controller = new AbortController();
      const settled = vi.fn();
      const source = createRun({ prompt: "cancel", messageId: "cancel" });
      source.abortSignal = controller.signal;
      source.turnAdoptionLifecycle = { onAdopted: vi.fn(), onSettled: settled };
      let attempts = 0;
      const run = async (queued: FollowupRun) => {
        if (queued.abortSignal?.aborted) {
          return;
        }
        attempts++;
        if (attempts === CAP && when === "in-flight") {
          controller.abort();
        }
        throw new Error("temporary");
      };
      enqueueFollowupRun(key, source, SETTINGS, "message-id", run, false);
      scheduleFollowupDrain(key, run);
      await finish();
      if (when === "suspended") {
        controller.abort();
        await finish();
      }
      expect(attempts).toBe(CAP);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(FOLLOWUP_QUEUES.has(key)).toBe(false);
      const delivered: string[] = [];
      enqueueFollowupRun(
        key,
        createRun({ prompt: "fresh", messageId: "fresh" }),
        SETTINGS,
        "message-id",
        async (queued) => {
          delivered.push(queued.prompt);
        },
      );
      await finish();
      expect(delivered).toEqual(["fresh"]);
    },
  );

  it("does not charge the next item for the preceding item's recovered failures", async () => {
    const attempts = new Map<string, number>();
    const delivered: string[] = [];
    for (const prompt of ["first", "second"]) {
      enqueueFollowupRun(key, createRun({ prompt, messageId: prompt }), SETTINGS);
    }
    scheduleFollowupDrain(key, async (run) => {
      const count = (attempts.get(run.prompt) ?? 0) + 1;
      attempts.set(run.prompt, count);
      if (count < CAP) {
        throw new Error("temporary");
      }
      delivered.push(run.prompt);
    });
    await flush();
    await finish();
    expect(delivered).toEqual(["first", "second"]);
    expect(errors.some((error) => error.includes("queue suspended"))).toBe(false);
  });

  it("parks a failed protected priority item without dropping the unrelated head", async () => {
    const delivered: string[] = [];
    enqueueFollowupRun(key, createRun({ prompt: "head", messageId: "head" }), SETTINGS);
    const priority = createRun({ prompt: "priority", messageId: "priority" });
    priority.protectFromQueueOverflow = true;
    enqueueFollowupRun(key, priority, SETTINGS);
    scheduleFollowupDrain(key, async (run) => {
      if (run.prompt === "priority") {
        throw new Error("priority failure");
      }
      delivered.push(run.prompt);
    });
    await flush();
    await finish();
    expect(delivered).toEqual([]);
    expect(FOLLOWUP_QUEUES.get(key)?.items.map((run) => run.prompt)).toEqual(["head", "priority"]);
    expect(errors.filter((error) => error.includes("queue suspended"))).toHaveLength(1);
  });

  it("parks a failing overflow summary without dropping any accepted work", async () => {
    const settings = { ...SETTINGS, cap: 1, dropPolicy: "summarize" as const };
    enqueueFollowupRun(key, createRun({ prompt: "summary", messageId: "summary" }), settings);
    enqueueFollowupRun(key, createRun({ prompt: "survivor", messageId: "survivor" }), settings);
    const delivered: string[] = [];
    let failures = 0;
    scheduleFollowupDrain(key, async (run) => {
      if (run.prompt.includes("[Queue overflow]")) {
        failures++;
        throw new Error("summary failure");
      }
      delivered.push(run.prompt);
    });
    await flush();
    await finish();
    expect(failures, JSON.stringify(errors)).toBe(CAP);
    expect(delivered).toEqual([]);
    expect(FOLLOWUP_QUEUES.get(key)?.items.map((run) => run.prompt)).toEqual(["survivor"]);
    expect(FOLLOWUP_QUEUES.get(key)?.summarySources.map((run) => run.prompt)).toEqual(["summary"]);
  });

  it("parks a failed collect batch without consuming work appended during its last attempt", async () => {
    const settings = { ...SETTINGS, mode: "collect" as const };
    for (const prompt of ["first", "second"]) {
      enqueueFollowupRun(key, createRun({ prompt, messageId: prompt }), settings);
    }
    let attempts = 0;
    const delivered: string[] = [];
    scheduleFollowupDrain(key, async (run) => {
      if (run.prompt.includes("first") || run.prompt.includes("second")) {
        attempts++;
        if (attempts === CAP) {
          enqueueFollowupRun(
            key,
            createRun({ prompt: "survivor", messageId: "survivor" }),
            settings,
          );
        }
        throw new Error("collect failure");
      }
      delivered.push(run.prompt);
    });
    await flush();
    await finish();
    expect(attempts, JSON.stringify(errors)).toBe(CAP);
    expect(delivered).toEqual([]);
    expect(FOLLOWUP_QUEUES.get(key)?.items.map((run) => run.prompt)).toEqual([
      "first",
      "second",
      "survivor",
    ]);
  });

  it("does not suspend a collect newcomer using a canceled source's exhausted budget", async () => {
    const settings = { ...SETTINGS, mode: "collect" as const };
    const controller = new AbortController();
    const settled = vi.fn();
    const source = createRun({ prompt: "older", messageId: "older" });
    source.abortSignal = controller.signal;
    source.turnAdoptionLifecycle = { onAdopted: vi.fn(), onSettled: settled };
    let attempts = 0;
    const delivered: string[] = [];
    const run = async (queued: FollowupRun) => {
      if (queued.abortSignal?.aborted) {
        return;
      }
      if (queued.prompt.includes("older")) {
        attempts++;
        if (attempts === CAP - 1) {
          enqueueFollowupRun(
            key,
            createRun({ prompt: "newcomer", messageId: "newcomer" }),
            settings,
          );
        }
        if (attempts === CAP) {
          controller.abort();
        }
        throw new Error("collect failure");
      }
      delivered.push(queued.prompt);
    };
    enqueueFollowupRun(key, source, settings, "message-id", run, false);
    scheduleFollowupDrain(key, run);
    await finish();
    expect(attempts).toBe(CAP);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("newcomer");
    expect(errors.some((error) => error.includes("queue suspended"))).toBe(false);
  });

  it("does not retire a survivor after a failing collect attempt already consumed its sources", async () => {
    const settings = { ...SETTINGS, mode: "collect" as const };
    for (const prompt of ["first", "second"]) {
      enqueueFollowupRun(key, createRun({ prompt, messageId: prompt }), settings);
    }
    let attempts = 0;
    const delivered: string[] = [];
    scheduleFollowupDrain(key, async (run) => {
      if (run.prompt.includes("first")) {
        if (++attempts === CAP) {
          await admitFollowupRunLifecycle(run);
          enqueueFollowupRun(
            key,
            createRun({ prompt: "survivor", messageId: "survivor" }),
            settings,
          );
        }
        throw new Error("failed collect admission attempt");
      }
      delivered.push(run.prompt);
    });
    await flush();
    await finish();
    expect(attempts).toBe(CAP);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain("survivor");
    expect(errors.some((error) => error.includes("queue suspended"))).toBe(false);
  });

  it("prevents enqueue and idle kicks from bypassing a pending backoff", async () => {
    const run = vi.fn(async () => {
      throw new Error("temporary");
    });
    enqueueFollowupRun(key, createRun({ prompt: "failed", messageId: "failed" }), SETTINGS);
    scheduleFollowupDrain(key, run);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    enqueueFollowupRun(key, createRun({ prompt: "later", messageId: "later" }), SETTINGS);
    scheduleFollowupDrain(key, run);
    await vi.advanceTimersByTimeAsync(499);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("clears retry timers and accounting before a key is recreated", async () => {
    const old = vi.fn(async () => {
      throw new Error("old failure");
    });
    enqueueFollowupRun(key, createRun({ prompt: "old", messageId: "old" }), SETTINGS);
    scheduleFollowupDrain(key, old);
    await flush();
    clearSessionQueues([key]);
    enqueueFollowupRun(key, createRun({ prompt: "new", messageId: "new" }), SETTINGS);
    await vi.advanceTimersByTimeAsync(500);
    expect(old).toHaveBeenCalledTimes(1);
    expect(FOLLOWUP_QUEUES.get(key)?.items.map((run) => run.prompt)).toEqual(["new"]);
    let attempts = 0;
    const delivered: string[] = [];
    scheduleFollowupDrain(key, async (run) => {
      if (++attempts < CAP) {
        throw new Error("new temporary failure");
      }
      delivered.push(run.prompt);
    });
    await flush();
    await finish();
    expect(delivered).toEqual(["new"]);
  });

  it("leaves deferred retries unbounded", async () => {
    let attempts = 0;
    enqueueFollowupRun(key, createRun({ prompt: "deferred", messageId: "deferred" }), SETTINGS);
    scheduleFollowupDrain(key, async (_run: FollowupRun) => {
      if (++attempts <= CAP + 3) {
        throw new FollowupRunDeferredError();
      }
    });
    await flush();
    await finish();
    expect(attempts).toBe(CAP + 4);
    expect(FOLLOWUP_QUEUES.has(key)).toBe(false);
    expect(errors.some((error) => error.includes("queue suspended"))).toBe(false);
  });
});
