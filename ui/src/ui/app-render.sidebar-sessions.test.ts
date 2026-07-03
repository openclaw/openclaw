// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSidebarRecentSessions } from "./app-render.ts";
import type { AppViewState } from "./app-view-state.ts";
import type { GatewaySessionRow } from "./types.ts";

function session(overrides: Partial<GatewaySessionRow> & { key: string }): GatewaySessionRow {
  return {
    kind: "direct",
    updatedAt: 0,
    ...overrides,
  };
}

function stateWithSessions(sessions: GatewaySessionRow[]): AppViewState {
  return {
    sessionKey: "main",
    sessionsResult: {
      ts: 0,
      path: "",
      count: sessions.length,
      defaults: { modelProvider: "openai", model: "gpt-5", contextTokens: null },
      sessions,
    },
  } as unknown as AppViewState;
}

describe("resolveSidebarRecentSessions", () => {
  let originalToSorted: unknown;

  beforeEach(() => {
    originalToSorted = Array.prototype.toSorted;
  });

  afterEach(() => {
    if (originalToSorted === undefined) {
      Reflect.deleteProperty(Array.prototype, "toSorted");
    } else {
      // eslint-disable-next-line no-extend-native
      Object.defineProperty(Array.prototype, "toSorted", {
        value: originalToSorted,
        configurable: true,
        writable: true,
      });
    }
  });

  it("returns the 5 most recently updated sessions sorted by updatedAt descending", () => {
    const sessions = [
      session({ key: "agent:main:discord:group:eng", updatedAt: 1000 }),
      session({ key: "agent:main:telegram:direct:user1", updatedAt: 3000 }),
      session({ key: "agent:main:imessage:direct:+1", updatedAt: 2000 }),
      session({ key: "agent:main:slack:direct:user2", updatedAt: 4000 }),
      session({ key: "agent:main:webchat:direct:user3", updatedAt: 500 }),
      session({ key: "agent:main:whatsapp:direct:user4", updatedAt: 2500 }),
    ];

    const result = resolveSidebarRecentSessions(stateWithSessions(sessions));

    expect(result.map((row) => row.key)).toEqual([
      "agent:main:slack:direct:user2",
      "agent:main:telegram:direct:user1",
      "agent:main:whatsapp:direct:user4",
      "agent:main:imessage:direct:+1",
      "agent:main:discord:group:eng",
    ]);
  });

  it("works when Array.prototype.toSorted is not available", () => {
    Reflect.deleteProperty(Array.prototype, "toSorted");
    expect(Array.prototype.toSorted).toBeUndefined();

    const sessions = [
      session({ key: "a", updatedAt: 1 }),
      session({ key: "b", updatedAt: 3 }),
      session({ key: "c", updatedAt: 2 }),
    ];

    const result = resolveSidebarRecentSessions(stateWithSessions(sessions));

    expect(result.map((row) => row.key)).toEqual(["b", "c", "a"]);
  });

  it("excludes archived, global, unknown, cron, subagent and spawned sessions", () => {
    const sessions = [
      session({ key: "agent:main:direct:one", updatedAt: 100 }),
      session({ key: "agent:main:direct:two", updatedAt: 200, archived: true }),
      session({ key: "global", kind: "global", updatedAt: 200 }),
      session({ key: "unknown", kind: "unknown", updatedAt: 200 }),
      session({ key: "cron:daily", kind: "cron", updatedAt: 200 }),
      session({ key: "agent:main:subagent:abc", kind: "direct", updatedAt: 200 }),
      session({
        key: "agent:main:direct:spawned",
        updatedAt: 200,
        spawnedBy: "agent:main:direct:one",
      }),
    ];

    const result = resolveSidebarRecentSessions(stateWithSessions(sessions));

    expect(result.map((row) => row.key)).toEqual(["agent:main:direct:one"]);
  });
});
