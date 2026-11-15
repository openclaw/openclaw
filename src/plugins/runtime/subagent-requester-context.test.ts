import { assert, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createPluginSubagentRequesterContext,
  resolvePluginSubagentCompletionRequester,
  type PluginSubagentRequesterContext,
  withPluginSubagentRequesterContext,
} from "./subagent-requester-context.js";

const lineage = {
  sessionKey: "agent:main:telegram:direct:123",
  origin: { channel: "telegram", to: "telegram:123", accountId: "work", threadId: 42 },
};

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
  assert(requester, "expected valid requester context");
  return requester;
}

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

  expect(requester).toEqual(lineage);
  expect(Object.isFrozen(requester)).toBe(true);
  expect(Object.isFrozen(requester?.origin)).toBe(true);
});

it.each([
  { origin: lineage.origin },
  { sessionKey: lineage.sessionKey, origin: { channel: "telegram" } },
])("rejects missing or invalid requester lineage: %j", (input) => {
  expect(createPluginSubagentRequesterContext(input)).toBeUndefined();
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
    return withPluginSubagentRequesterContext(requester, async () => {
      expect(getActiveRequester()).toBe(requester);
      await gate.promise;
      expect(getActiveRequester()).toBe(requester);
    });
  });
  // Scope callbacks enter synchronously, so both are waiting at the gate now.
  gate.resolve();
  await Promise.all(runs);
  expect(getActiveRequester()).toBeUndefined();
});
