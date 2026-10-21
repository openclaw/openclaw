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

function makeRequester(id: string) {
  const requester = createPluginSubagentRequesterContext({
    sessionKey: `agent:main:telegram:direct:${id}`,
    origin: { channel: "telegram", to: `telegram:${id}`, accountId: id },
  });
  if (!requester) {
    throw new Error("expected valid requester context");
  }
  return requester;
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
    const requester = makeRequester("123");

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
    const gate = createDeferred();
    const runs = ["first", "second"].map((id) => {
      const requester = makeRequester(id);
      const started = createDeferred();
      const run = withPluginSubagentRequesterContext(requester, async () => {
        expect(getActiveRequester()).toBe(requester);
        started.resolve();
        await gate.promise;
        expect(getActiveRequester()).toBe(requester);
      });
      return { started: started.promise, run };
    });
    await Promise.all(runs.map(({ started }) => started));
    gate.resolve();
    await Promise.all(runs.map(({ run }) => run));
    expect(getActiveRequester()).toBeUndefined();
  });
});
