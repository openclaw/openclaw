import { describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createPluginSubagentRequesterContext,
  resolvePluginSubagentCompletionRequester,
  type PluginSubagentRequesterContext,
  withPluginSubagentRequesterContext,
} from "./subagent-requester-context.js";

function getActiveRequester(): PluginSubagentRequesterContext | undefined {
  try {
    return resolvePluginSubagentCompletionRequester("current-requester");
  } catch {
    return undefined;
  }
}

describe("plugin subagent requester context", () => {
  it("normalizes and freezes host-owned requester lineage", () => {
    const requester = createPluginSubagentRequesterContext({
      sessionKey: "  agent:main:telegram:direct:123  ",
      origin: {
        channel: " Telegram ",
        to: " telegram:123 ",
        accountId: " Work ",
        threadId: 42,
      },
    });

    expect(requester).toEqual({
      sessionKey: "agent:main:telegram:direct:123",
      origin: {
        channel: "telegram",
        to: "telegram:123",
        accountId: "work",
        threadId: 42,
      },
    });
    expect(Object.isFrozen(requester)).toBe(true);
    expect(Object.isFrozen(requester?.origin)).toBe(true);
  });

  it("rejects missing or invalid requester lineage", () => {
    expect(
      createPluginSubagentRequesterContext({
        origin: { channel: "telegram", to: "telegram:123" },
      }),
    ).toBeUndefined();
    expect(
      createPluginSubagentRequesterContext({
        sessionKey: "agent:main:telegram:direct:123",
        origin: { channel: "telegram" },
      }),
    ).toBeUndefined();
  });

  it("expires requester authority when the hook invocation returns", async () => {
    const requester = createPluginSubagentRequesterContext({
      sessionKey: "agent:main:telegram:direct:123",
      origin: { channel: "telegram", to: "telegram:123" },
    });
    if (!requester) {
      throw new Error("expected valid requester context");
    }

    const detachedGate = createDeferred();
    let detachedRead: Promise<PluginSubagentRequesterContext | undefined> | undefined;
    await withPluginSubagentRequesterContext(requester, async () => {
      expect(getActiveRequester()).toBe(requester);
      detachedRead = (async () => {
        await detachedGate.promise;
        return getActiveRequester();
      })();
    });

    detachedGate.resolve();
    await expect(detachedRead).resolves.toBeUndefined();
    expect(getActiveRequester()).toBeUndefined();
  });

  it("isolates concurrent requester scopes", async () => {
    const first = createPluginSubagentRequesterContext({
      sessionKey: "agent:main:telegram:direct:first",
      origin: { channel: "telegram", to: "telegram:first", accountId: "first" },
    });
    const second = createPluginSubagentRequesterContext({
      sessionKey: "agent:main:telegram:direct:second",
      origin: { channel: "telegram", to: "telegram:second", accountId: "second" },
    });
    if (!first || !second) {
      throw new Error("expected valid requester contexts");
    }

    const gate = createDeferred();
    const firstStarted = createDeferred();
    const secondStarted = createDeferred();

    const firstRun = withPluginSubagentRequesterContext(first, async () => {
      expect(getActiveRequester()).toBe(first);
      firstStarted.resolve();
      await gate.promise;
      expect(getActiveRequester()).toBe(first);
    });
    const secondRun = withPluginSubagentRequesterContext(second, async () => {
      expect(getActiveRequester()).toBe(second);
      secondStarted.resolve();
      await gate.promise;
      expect(getActiveRequester()).toBe(second);
    });

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    gate.resolve();
    await Promise.all([firstRun, secondRun]);
    expect(getActiveRequester()).toBeUndefined();
  });
});
