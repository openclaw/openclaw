import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { runMeetingBrowserAct } from "./browser-act-lock.js";
import { leaveMeetingWithBrowser } from "./browser-session-control.js";
import type { MeetingBrowserLeaveStep } from "./platform-adapter-contract.js";

type LeaveParams = Parameters<typeof leaveMeetingWithBrowser>[0];
afterEach(() => vi.useRealTimers());

function startLeaving(
  step: (evaluation: number) => MeetingBrowserLeaveStep,
  options: {
    openedByPlugin?: boolean;
    buildSessionLeaveScript?: LeaveParams["adapter"]["browser"]["buildSessionLeaveScript"];
    onDelete?: () => Promise<void>;
  } = {},
) {
  const buildLeaveScript = vi.fn(() => "() => '{}'");
  const deletedTabs: string[] = [];
  let evaluation = 0;
  const leaving = leaveMeetingWithBrowser({
    adapter: {
      browserLabel: "Test meeting",
      browser: {
        buildLeaveScript,
        buildSessionLeaveScript: options.buildSessionLeaveScript,
        parseLeaveResult: () => step(evaluation),
      },
    } as never,
    callBrowser: async (request) => {
      if (request.path === "/tabs") {
        return { tabs: [{ targetId: "target-1", url: "https://meet.test/meeting" }] };
      }
      if (request.path === "/act") {
        evaluation += 1;
        return { result: "{}" };
      }
      if (request.method === "DELETE") {
        deletedTabs.push(request.path);
        await options.onDelete?.();
        return {};
      }
      throw new Error(`Unexpected browser request: ${request.method} ${request.path}`);
    },
    launch: true,
    meetingSessionId: "session-1",
    meetingUrl: "https://meet.test/meeting",
    tab: { targetId: "target-1", openedByPlugin: options.openedByPlugin ?? true },
    timeoutMs: 1_000,
  });
  return { leaving, buildLeaveScript, deletedTabs, evaluations: () => evaluation };
}

describe("meeting browser leave ownership", () => {
  it.each([
    [
      { departed: false, sessionConflict: true, sessionMatched: false },
      true,
      true,
      "Test meeting tab belongs to another OpenClaw meeting session; left its current call untouched.",
    ],
    [
      { departed: false, sessionMatched: false },
      true,
      false,
      "Browser control could not verify that the Test meeting tab still belongs to this OpenClaw meeting session.",
    ],
    [
      { departed: true },
      false,
      true,
      "Clicked Test meeting's Leave call button; kept the reused browser tab open.",
    ],
  ] as const)(
    "keeps tab ownership for %j (plugin=%s, left=%s)",
    async (step, openedByPlugin, left, note) => {
      const { leaving, buildLeaveScript, deletedTabs } = startLeaving(
        () => ({ ...step, urlMatched: true }),
        { openedByPlugin },
      );
      await expect(leaving).resolves.toEqual({ left, note });
      expect(buildLeaveScript).toHaveBeenCalledWith("https://meet.test/meeting");
      expect(deletedTabs).toEqual([]);
    },
  );

  it("carries initiated-leave evidence into the next page evaluation", async () => {
    const leaveInitiated: boolean[] = [];
    const deleteStarted = createDeferredCore();
    const deleteGate = createDeferredCore();
    const { leaving, deletedTabs } = startLeaving(
      (evaluation) =>
        evaluation === 1
          ? { departed: false, leaveAction: "leave", urlMatched: true }
          : evaluation === 2
            ? { departed: false, sessionMatched: false, urlMatched: true }
            : { departed: true, urlMatched: false },
      {
        buildSessionLeaveScript: (context) => {
          leaveInitiated.push(context.leaveInitiated);
          return "() => '{}'";
        },
        onDelete: async () => {
          deleteStarted.resolve();
          await deleteGate.promise;
        },
      },
    );

    await deleteStarted.promise;
    let concurrentStarted = false;
    const concurrent = runMeetingBrowserAct({
      deadline: performance.now() + 1_000,
      targetId: "target-1",
      operation: async () => {
        concurrentStarted = true;
      },
    });
    await Promise.resolve();
    expect(concurrentStarted).toBe(false);
    deleteGate.resolve();
    const result = await leaving;
    await concurrent;
    expect(leaveInitiated).toEqual([false, true, true]);
    expect(deletedTabs).toEqual(["/tabs/target-1"]);
    expect(concurrentStarted).toBe(true);
    expect(result.left).toBe(true);
  });

  it("reserves enough time to close a plugin tab after leave polling expires", async () => {
    vi.useFakeTimers();
    const { leaving, deletedTabs, evaluations } = startLeaving((evaluation) =>
      evaluation === 1
        ? { departed: false, leaveAction: "leave", urlMatched: true }
        : { departed: false, urlMatched: true },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    const result = await leaving;
    expect(evaluations()).toBeGreaterThan(1);
    expect(deletedTabs).toEqual(["/tabs/target-1"]);
    expect(result).toEqual({
      left: true,
      note: "Clicked Test meeting's Leave call button and closed the Test meeting tab.",
    });
  });
});
