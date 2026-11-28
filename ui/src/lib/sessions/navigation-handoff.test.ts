// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  consumeSessionNavigationHandoff,
  prepareSessionNavigationHandoff,
} from "./navigation-handoff.ts";
it("retains one navigation relationship through a slow import and rejects replacement connections", () => {
  vi.useFakeTimers();
  try {
    const owner = { snapshot: { client: {}, hello: {} } };
    const relation = { relationship: "involving", target: { type: "me" } } as const;
    prepareSessionNavigationHandoff(owner, "/chat/shared", "shared", relation);
    vi.advanceTimersByTime(30_000);
    expect(consumeSessionNavigationHandoff(owner, "/chat/shared", "shared")).toEqual({
      pathname: "/chat/shared",
      sessionKey: "shared",
      catalogProfileRelation: relation,
      ...owner.snapshot,
    });
    expect(consumeSessionNavigationHandoff(owner, "/chat/shared")).toBeUndefined();
    prepareSessionNavigationHandoff(owner, "/chat/shared", "shared", relation);
    owner.snapshot.hello = {};
    expect(consumeSessionNavigationHandoff(owner, "/chat/shared")).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
