import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { sessionTitleRequests } from "./session-title-state.js";

it.each(["fulfilled", "rejected"])(
  "publishes registry state after insertion and %s eviction",
  async (outcome) => {
    const target = {
      storePath: "/synthetic/sessions.sqlite",
      sessionKey: "agent:main:dashboard:title",
      sessionId: outcome,
    };
    const generation = createDeferredCore<boolean>();
    const states: boolean[] = [];
    const changed = () => states.push(sessionTitleRequests.get(target) !== undefined);
    const request = sessionTitleRequests.run(target, () => generation.promise, changed);
    const duplicate = vi.fn();
    expect(sessionTitleRequests.run(target, duplicate, changed)).toBe(request);
    expect(duplicate).not.toHaveBeenCalled();
    expect(states).toEqual([true]);
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
