import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { sessionTitleRequests } from "./session-title-state.js";

it("hands the reserved create row to naming without exposing a provisional title", async () => {
  const target = {
    storePath: "/synthetic/agents/main/sessions/sessions.json",
    sessionKey: "agent:main:dashboard:creating",
    sessionId: "creating",
  };
  const release = sessionTitleRequests.holdCreation(target);
  expect(sessionTitleRequests.isPending(target)).toBe(true);
  const answer = createDeferredCore<boolean>();
  const generation = sessionTitleRequests.run(target, () => answer.promise);
  release();
  expect(sessionTitleRequests.isPending(target)).toBe(true);
  answer.resolve(false);
  await generation;
  expect(sessionTitleRequests.isPending(target)).toBe(false);
  const cancelled = sessionTitleRequests.holdCreation(target);
  cancelled();
  expect(sessionTitleRequests.isPending(target)).toBe(false);
});

it.each(["fulfilled", "rejected"])(
  "publishes registry state after insertion and %s eviction",
  async (outcome) => {
    const target = {
      storePath: "/synthetic/agents/main/sessions/sessions.json",
      sessionKey: "agent:main:dashboard:title",
      sessionId: outcome,
    };
    const generation = createDeferredCore<boolean>();
    const states: boolean[] = [];
    const started = createDeferredCore();
    const changed = () => states.push(sessionTitleRequests.isPending(target));
    const request = sessionTitleRequests.run(
      target,
      (markStarted) => {
        markStarted();
        started.resolve();
        return generation.promise;
      },
      changed,
    );
    const duplicate = vi.fn();
    expect(sessionTitleRequests.run(target, duplicate, changed)).toBe(request);
    expect(duplicate).not.toHaveBeenCalled();
    expect(sessionTitleRequests.isPending(target)).toBe(false);
    await started.promise;
    expect(states).toEqual([true]);
    expect(
      sessionTitleRequests.isPending({
        ...target,
        storePath: "/synthetic/agents/main/agent/openclaw-agent.sqlite",
      }),
    ).toBe(true);
    expect(
      sessionTitleRequests.get({ ...target, sessionId: "another-generation" }),
    ).toBeUndefined();
    expect(
      sessionTitleRequests.get({ ...target, storePath: "/another/store.sqlite" }),
    ).toBeUndefined();
    if (outcome === "rejected") {
      const rejected = expect(request).rejects.toThrow("write failed");
      generation.reject(new Error("write failed"));
      await rejected;
    } else {
      generation.resolve(false);
      await expect(request).resolves.toBe(false);
    }
    expect(states).toEqual([true, false]);
    expect(sessionTitleRequests.get(target)).toBeUndefined();
  },
);
