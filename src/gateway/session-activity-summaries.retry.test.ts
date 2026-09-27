import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { sessionActivitySummaryHandlers } from "./server-methods/session-activity-summary.js";
import {
  createSessionActivitySummaries,
  type SessionActivitySummaryService,
} from "./session-activity-summaries.js";
import {
  projectSessionActivitySummary,
  type ActivitySummaryTarget,
} from "./session-activity-summary-state.js";
import type { defaultCompleteModel } from "./session-observer-model.js";

const result = {
  text: "Verified the change.",
  provider: "test",
  model: "utility",
  owner: { kind: "harness" as const, id: "test" },
};
const scope = (target: ActivitySummaryTarget) => ({
  agentId: target.agentId,
  sessionKey: target.key,
  sessionId: target.key,
});

describe("Activity recap admission, refresh, and provider recovery", () => {
  let testState: OpenClawTestState;
  let service: SessionActivitySummaryService;
  let cfg: OpenClawConfig;
  const complete = vi.fn<typeof defaultCompleteModel>();
  const changed = vi.fn();
  const view = (target: ActivitySummaryTarget) =>
    projectSessionActivitySummary({
      ...target,
      cfg,
      entry: loadSessionEntryReadOnly(scope(target)),
    });
  const addSession = async (index: number, agentId = "main") => {
    const target = { agentId, key: `agent:${agentId}:recap-${index}` };
    await upsertSessionEntryCore(scope(target), { sessionId: target.key, updatedAt: 1 });
    await persistSessionTranscriptTurn(scope(target), {
      messages: [
        { eventId: `message-${index}`, message: { role: "user", content: `Request ${index}` } },
      ],
      touchSessionEntry: false,
    });
    return target;
  };
  const appendWork = async (target: ActivitySummaryTarget) => {
    await persistSessionTranscriptTurn(scope(target), {
      messages: [
        {
          eventId: "new-work",
          parentId: "message-1",
          message: { role: "assistant", content: "Verified additional work." },
        },
      ],
      touchSessionEntry: false,
    });
  };
  const fakeTime = () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.spyOn(Math, "random").mockReturnValue(0);
  };

  const createService = () =>
    createSessionActivitySummaries({
      getConfig: () => cfg,
      onChanged: changed,
      prepareModel: async ({ agentId, modelRef }) => ({
        config: cfg,
        agentId,
        provider: "test",
        model: modelRef?.split("/")[1] ?? "utility",
        authProfileId: undefined,
        agentDir: "/tmp/unused",
        outputTextPolicy: "strict-visible",
      }),
      completeModel: complete,
    });

  beforeEach(async () => {
    testState = await createOpenClawTestState({ scenario: "minimal" });
    cfg = { agents: { defaults: { utilityModel: "test/utility" } } };
    complete.mockReset().mockResolvedValue(result);
    changed.mockReset();
    service = createService();
  });
  afterEach(async () => {
    await service.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await testState.cleanup();
  });

  it.each([false, true])(
    "restyles old cached text once while retaining coverage (new work: %s)",
    async (newWork) => {
      const target = await addSession(1);
      service.ensure(target);
      await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
      const oldText = "Ran internal_tool and checked the result. Waiting for review.";
      await patchSessionEntryCore(
        scope(target),
        (entry) => ({
          activitySummary: { ...entry.activitySummary!, formatRevision: undefined, text: oldText },
        }),
        { preserveActivity: true },
      );
      if (newWork) {
        await appendWork(target);
      }
      expect(view(target)).toMatchObject({ state: "stale", text: oldText });
      const restyled = createDeferred<typeof result>();
      complete.mockImplementationOnce(() => restyled.promise);
      try {
        expect(service.ensure(target)).toMatchObject({ state: "updating", text: oldText });
        await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
        expect(JSON.parse(complete.mock.calls[1]![0].prompt)).toMatchObject({
          previousRecap: oldText,
          messages: newWork ? ["assistant: Verified additional work."] : [],
        });
        restyled.resolve({ ...result, text: "Verified the change. Waiting for review." });
        await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
        expect(loadSessionEntryReadOnly(scope(target))?.activitySummary).toMatchObject({
          version: 1,
          formatRevision: 2,
          text: "Verified the change. Waiting for review.",
          coveredMessages: newWork ? 2 : 1,
          totalMessages: newWork ? 2 : 1,
        });
      } finally {
        restyled.resolve({ ...result, text: "Verified the change. Waiting for review." });
      }
      await service.dispose();
      service = createService();
      service.ensure(target);
      await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
      service.ensure(target);
      await service.dispose();
      expect(complete).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["new transcript", "older format"] as const)(
    "retains the previous recap on failure for %s without rebilling repeated requests",
    async (trigger) => {
      const target = await addSession(1);
      service.ensure(target);
      await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
      if (trigger === "new transcript") {
        await appendWork(target);
      } else {
        await patchSessionEntryCore(
          scope(target),
          (entry) => ({
            activitySummary: { ...entry.activitySummary!, formatRevision: undefined },
          }),
          { preserveActivity: true },
        );
      }
      complete.mockRejectedValue(new Error("temporary failure"));
      service.ensure(target);
      await vi.waitFor(() => expect(view(target)?.state).toBe("unavailable"));
      for (let index = 0; index < 20; index += 1) {
        service.ensure(target);
      }
      expect(view(target)?.text).toBe(result.text);
      expect(complete).toHaveBeenCalledTimes(2);
    },
  );

  it("queues a full Activity page and reports admission limits until a slot settles", async () => {
    const targets: ActivitySummaryTarget[] = [];
    for (let index = 0; index < 257; index += 1) {
      targets.push(await addSession(index));
    }
    const overflow = targets[256]!;
    service.ensure(overflow);
    await vi.waitFor(() => expect(view(overflow)?.state).toBe("current"));
    await service.dispose();
    service = createService();
    complete.mockClear();
    const first = createDeferred<typeof result>();
    const remaining = createDeferred<typeof result>();
    const drained = createDeferred();
    const completed = new Set<string>();
    changed.mockImplementation((target: ActivitySummaryTarget) => {
      if (view(target)?.state === "current") {
        completed.add(target.key);
        if (completed.size === targets.length) {
          drained.resolve();
        }
      }
    });
    complete
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(() => remaining.promise);
    const context = createDirectChatContext({
      getRuntimeConfig: () => cfg,
      sessionActivitySummaries: service,
    });
    const respond = vi.fn();
    const ensure = async (sessions: ActivitySummaryTarget[]) => {
      const params = { sessions };
      await sessionActivitySummaryHandlers["sessions.activitySummary.ensure"]!({
        req: { type: "req", id: "capacity", method: "sessions.activitySummary.ensure", params },
        params,
        context,
        client: null,
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond.mock.calls.at(-1)?.[0]).toBe(true);
    };
    try {
      for (let index = 0; index < 100; index += 20) {
        await ensure(targets.slice(index, index + 20));
      }
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
      expect(targets.slice(0, 100).map((target) => view(target)?.state)).toEqual(
        Array.from({ length: 100 }, () => "updating"),
      );
      for (let index = 100; index < 256; index += 20) {
        await ensure(targets.slice(index, Math.min(index + 20, 256)));
      }
      expect(targets.slice(0, 256).every((target) => view(target)?.state === "updating")).toBe(
        true,
      );
      await ensure([overflow]);
      expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
        sessions: [
          {
            ...overflow,
            activitySummary: { state: "current", text: result.text, canEnsure: true },
          },
        ],
      });
      expect(view(overflow)?.state).toBe("current");
      await persistSessionTranscriptTurn(scope(overflow), {
        messages: [
          {
            eventId: "overflow-new-work",
            parentId: "message-256",
            message: { role: "assistant", content: "Verified additional work." },
          },
        ],
        touchSessionEntry: false,
      });
      await ensure([overflow]);
      expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
        sessions: [
          {
            ...overflow,
            activitySummary: { state: "unavailable", text: result.text, canEnsure: true },
          },
        ],
      });
      expect(complete).toHaveBeenCalledTimes(2);
      first.resolve(result);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(3));
      await ensure([overflow]);
      expect(respond.mock.calls.at(-1)?.[1]).toMatchObject({
        sessions: [
          {
            ...overflow,
            activitySummary: { state: "updating", text: result.text, canEnsure: true },
          },
        ],
      });
      remaining.resolve(result);
      await drained.promise;
      expect(targets.every((target) => view(target)?.state === "current")).toBe(true);
      expect(complete).toHaveBeenCalledTimes(257);
    } finally {
      first.resolve(result);
      remaining.resolve(result);
    }
  });

  it.each([
    {
      name: "overload",
      error: Object.assign(new Error("Overloaded"), { status: 529 }),
      delay: 30_000,
    },
    {
      name: "rate-limit response headers",
      error: Object.assign(new Error("Too many requests"), {
        status: 429,
        headers: new Headers({ "Retry-After": "90" }),
      }),
      delay: 90_000,
    },
    {
      name: "provider retry timing",
      error: Object.assign(new Error("Too many requests"), { status: 429, retryAfterMs: 90_000 }),
      delay: 90_000,
    },
    {
      name: "network interruption",
      error: new Error("fetch failed", {
        cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      }),
      delay: 30_000,
    },
  ])(
    "retries $name automatically and retains cached text without rebilling repeated ensure requests",
    async ({ error, delay }) => {
      const target = await addSession(1);
      service.ensure(target);
      await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
      await appendWork(target);
      fakeTime();
      complete.mockRejectedValueOnce(error);
      service.ensure(target);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
      await vi.advanceTimersByTimeAsync(0);
      const failedAt = Date.now();
      for (let index = 0; index < 20; index += 1) {
        service.ensure(target);
      }
      expect(view(target)).toMatchObject({ state: "updating", text: result.text });
      await vi.advanceTimersByTimeAsync(delay - 1_000);
      expect(complete).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
      expect(Date.now() - failedAt).toBeGreaterThanOrEqual(delay);
      expect(complete).toHaveBeenCalledTimes(3);
    },
  );

  it("pauses the overloaded model while serving another model, then retries at the queue tail", async () => {
    const first = await addSession(1);
    const next = await addSession(2);
    const blocker = await addSession(3, "healthy");
    const healthy = await addSession(4, "healthy");
    cfg.agents!.list = [{ id: "main" }, { id: "healthy", utilityModel: "test/other" }];
    const failure = createDeferred<typeof result>();
    const release = createDeferred<typeof result>();
    complete
      .mockImplementationOnce(() => failure.promise)
      .mockImplementationOnce(() => release.promise);
    fakeTime();
    try {
      service.ensure(first);
      service.ensure(blocker);
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
      service.ensure(next);
      service.ensure(healthy);
      failure.reject(Object.assign(new Error("Overloaded"), { status: 529 }));
      await vi.waitFor(() => expect(view(healthy)?.state).toBe("current"));
      expect(complete).toHaveBeenCalledTimes(3);
      expect(view(first)?.state).toBe("updating");
      expect(view(next)?.state).toBe("updating");
      release.resolve(result);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(view(first)?.state).toBe("current"));
      await vi.waitFor(() => expect(view(next)?.state).toBe("current"));
      expect(
        complete.mock.calls.map(([request]) => JSON.parse(request.prompt).messages[0]),
      ).toEqual([
        "user: Request 1",
        "user: Request 3",
        "user: Request 4",
        "user: Request 2",
        "user: Request 1",
      ]);
    } finally {
      failure.resolve(result);
      release.resolve(result);
    }
  });

  it.each(["ensure", "new transcript"] as const)(
    "stops after bounded retries and starts a fresh retry chain for %s after cooldown",
    async (trigger) => {
      const target = await addSession(1);
      fakeTime();
      complete.mockRejectedValue(Object.assign(new Error("Overloaded"), { status: 529 }));
      service.ensure(target);
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(attempt));
        await vi.advanceTimersByTimeAsync(attempt < 4 ? 30_000 * 2 ** (attempt - 1) : 0);
      }
      expect(view(target)?.state).toBe("unavailable");
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(complete).toHaveBeenCalledTimes(4);
      complete
        .mockResolvedValue(result)
        .mockRejectedValueOnce(Object.assign(new Error("Overloaded again"), { status: 529 }));
      if (trigger === "ensure") {
        service.ensure(target);
      } else {
        await appendWork(target);
        service.handleTranscript({ target: scope(target) });
      }
      await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(5));
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.waitFor(() => expect(view(target)?.state).toBe("current"));
      expect(complete).toHaveBeenCalledTimes(6);
    },
  );

  it.each([
    new Error("No API key found for provider test"),
    Object.assign(new Error("Invalid API key"), { status: 401 }),
    Object.assign(new Error("Insufficient quota; check your billing plan"), { status: 429 }),
    Object.assign(new Error("Daily request limit exceeded"), { status: 429 }),
    new Error("Isolated completion failed with stop reason error.", {
      cause: { status: 429, message: "Daily request limit exceeded" },
    }),
    Object.assign(new Error("Isolated completion is unsupported"), { code: "unsupported" }),
  ])("does not automatically retry a permanent failure: %s", async (error) => {
    const target = await addSession(1);
    fakeTime();
    complete.mockRejectedValue(error);
    service.ensure(target);
    await vi.waitFor(() => expect(view(target)?.state).toBe("unavailable"));
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each(["delete", "dispose"] as const)("cancels a deferred retry on %s", async (action) => {
    const target = await addSession(1);
    fakeTime();
    complete.mockRejectedValueOnce(Object.assign(new Error("Overloaded"), { status: 529 }));
    service.ensure(target);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(0);
    if (action === "delete") {
      await deleteSessionEntryLifecycle({
        agentId: target.agentId,
        archiveTranscript: false,
        storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: target.agentId }),
        target: { canonicalKey: target.key, storeKeys: [target.key] },
      });
    } else {
      await service.dispose();
    }
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(loadSessionEntryReadOnly(scope(target))?.activitySummary).toBeUndefined();
  });
});
