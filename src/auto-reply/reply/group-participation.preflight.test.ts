import { beforeEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { readSessionEntryInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { getSessionControllerOperation } from "../../sessions/session-controller.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { judgment } from "./group-participation.decision.test-support.js";
import {
  fixture,
  models,
  acceptGroupInputForActiveReply,
} from "./group-participation.runner.test-support.js";

const preflight = vi.hoisted(() =>
  vi.fn<typeof import("./agent-runner-memory.js").runSessionCompactionIfNeeded>(),
);
vi.mock("./agent-runner-memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-runner-memory.js")>()),
  runSessionCompactionIfNeeded: preflight,
}));

beforeEach(() => {
  preflight.mockReset();
  preflight.mockImplementation(async (params) => params.sessionEntry);
});

it("shares one assessment deadline across a changed-input reassessment", async () => {
  const groupId = "-10122";
  const now = performance.now.bind(performance);
  let elapsed = 0;
  let remaining: number | undefined;
  const clock = vi.spyOn(performance, "now").mockImplementation(() => now() + elapsed);
  models.decision.mockImplementationOnce(async (batch) => {
    elapsed += 20_000;
    return judgment(batch, { attention: "none" });
  });
  models.decision.mockImplementation(async (batch, options) => {
    remaining = options?.timeoutMs;
    return judgment(batch, { attention: "engagement" });
  });
  models.embedded.mockResolvedValue({
    payloads: [{ text: "The answer." }],
    meta: { durationMs: 1 },
  });
  try {
    await fixture.reply("Bob, which port?", "assessment-budget", groupId, {
      onRunVerbosityResolved: () => acceptGroupInputForActiveReply(groupId),
    });
    expect(models.decision).toHaveBeenCalledTimes(2);
    expect(remaining).toBeLessThanOrEqual(10_000);
    expect(models.embedded).toHaveBeenCalledOnce();
  } finally {
    clock.mockRestore();
  }
});

it.each(["instant", "message"] as const)(
  "restores ordinary %s typing after reassessment is unavailable",
  async (typingMode) => {
    const groupId = "-10124";
    fixture.config.agents!.defaults!.typingMode = typingMode;
    models.decision.mockImplementationOnce(async (batch) =>
      judgment(batch, { attention: "engagement" }),
    );
    models.decision.mockResolvedValue({ status: "unavailable", reason: "disabled" });
    const onReplyStart = vi.fn();
    let typingOnModelEntry = -1;
    models.embedded.mockImplementation(async () => {
      typingOnModelEntry = onReplyStart.mock.calls.length;
      return { payloads: [{ text: "The ordinary answer." }], meta: { durationMs: 1 } };
    });
    await fixture.reply("Bob, which port?", "unavailable-reassessment", groupId, {
      onReplyStart,
      onRunVerbosityResolved: () => acceptGroupInputForActiveReply(groupId),
    });
    expect(typingOnModelEntry).toBe(typingMode === "instant" ? 1 : 0);
  },
);

it.for(["maintenance failure", "renderable failure", "authority failure"] as const)(
  "settles a newly approved queued reply when preparation fails (%s)",
  async (outcome, { signal }) => {
    const groupId = "-10125";
    const sourceId = `queued-preflight-${outcome}`;
    const events: string[] = [];
    const entered = createDeferred();
    const release = createDeferred();
    const published = createDeferred();
    const settled = createDeferred();
    let operation: ReplyOperation | undefined;
    models.decision.mockImplementationOnce(async (batch) => judgment(batch, { attention: "none" }));
    models.decision.mockImplementation(async (batch) =>
      judgment(batch, { attention: "engagement" }),
    );
    models.embedded.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return { payloads: [{ text: "First answer." }], meta: { durationMs: 1 } };
    });
    preflight.mockImplementation(async (params) => {
      if (params.followupRun.messageId === sourceId) {
        events.push("maintenance");
        if (outcome === "maintenance failure") {
          throw new Error("Preflight maintenance unavailable");
        }
        if (outcome === "renderable failure") {
          throw new Error(
            "Preflight compaction required but failed: synthetic maintenance failure",
          );
        }
      }
      return params.sessionEntry;
    });
    const first = fixture.dispatch(
      "Agent, first question?",
      `before-${sourceId}`,
      groupId,
      undefined,
      true,
    );
    let queued: ReturnType<typeof fixture.dispatch> | undefined;
    try {
      await withinTest(
        awaitGateBeforeSettlement(entered.promise, first, "The first reply did not start"),
        signal,
      );
      queued = fixture.dispatch(
        "Bob, queued question?",
        sourceId,
        groupId,
        {
          onRunVerbosityResolved: () => {
            operation = getSessionControllerOperation(`agent:main:telegram:group:${groupId}`);
            if (!operation) {
              throw new Error("The approved reply owner is missing");
            }
            acceptGroupInputForActiveReply(groupId);
            if (outcome === "authority failure") {
              vi.spyOn(operation, "bindToolAuthoritySnapshotAsync").mockRejectedValue(
                new Error("Tool authority unavailable before execution"),
              );
            }
          },
          onQueuedFollowupSettled: () => settled.resolve(),
        },
        false,
        () => published.resolve(),
      );
      await withinTest(
        awaitGateBeforeSettlement(published.promise, queued, "The queued reply was not published"),
        signal,
      );
    } finally {
      release.resolve();
      await first;
      await queued;
    }
    await withinTest(settled.promise, signal);
    await operation?.ownerSettlement;
    expect(events).toEqual(["maintenance"]);
    expect(models.decision).toHaveBeenCalledTimes(2);
    expect(models.embedded).toHaveBeenCalledOnce();
    expect(operation?.result).toMatchObject({ kind: "failed", code: "run_failed" });
    const entry = await readSessionEntryInWorker({
      storePath: fixture.storePath,
      sessionKey: `agent:main:telegram:group:${groupId}`,
    });
    expect(entry?.status).toBe("failed");
    expect(entry?.lifecycleRunId).toBeUndefined();
  },
);
