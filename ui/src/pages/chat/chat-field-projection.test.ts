import { createEffect, createRoot, flush } from "solid-js";
import { expect, it, onTestFinished } from "vitest";
import { projectChatFields } from "./chat-field-projection.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createTestPageState } from "./chat-page-state.test-support.ts";

function root<T>(setup: () => T): T {
  return createRoot((dispose) => {
    onTestFinished(dispose);
    return setup();
  });
}

function observe<T>(read: () => T): T[] {
  const values: T[] = [];
  createEffect(read, (value) => void values.push(value));
  return values;
}
function published<T>(actual: T, expected: T) {
  flush();
  expect(actual).toEqual(expected);
}

it("publishes fields independently while owner reads and array identity stay synchronous", () => {
  const owner = { loading: false, messages: ["first"], unrelated: 0 };
  const { messages, loading } = root(() => {
    expect(projectChatFields(owner, ["loading", "messages"])).toBe(owner);
    return { messages: observe(() => owner.messages), loading: observe(() => owner.loading) };
  });
  const expectPublished = (expectedMessages: string[][], expectedLoading: boolean[]) => {
    flush();
    expect({ messages, loading }).toEqual({ messages: expectedMessages, loading: expectedLoading });
  };
  flush();
  const next = ["first", "second"];
  owner.messages = next;
  expect(owner.messages).toBe(next);
  expect(messages).toEqual([["first"]]);
  expectPublished([["first"], ["first", "second"]], [false]);
  expect(messages[1]).toBe(next);

  owner.messages = next;
  owner.unrelated += 1;
  expectPublished([["first"], ["first", "second"]], [false]);

  owner.loading = true;
  expect(owner.loading).toBe(true);
  expectPublished([["first"], ["first", "second"]], [false, true]);
});

it("keeps callback values and existing accessor ownership when selecting all fields", () => {
  const callback = () => "initial";
  let ownedValue = "first";
  const owner = {
    callback,
    get owned() {
      return ownedValue;
    },
    set owned(value: string) {
      ownedValue = value;
    },
  };
  root(() => projectChatFields(owner));
  expect(owner.callback).toBe(callback);
  owner.owned = "second";
  expect(ownedValue).toBe("second");
  const replacement = () => "replacement";
  owner.callback = replacement;
  expect(owner.callback).toBe(replacement);
  flush();
  expect(owner.callback()).toBe("replacement");
});

it("observes current owner values after pre-render writes and a previous reader retires", () => {
  const owner = root(() => projectChatFields({ value: "initial" }));
  owner.value = "before render";
  const first = createRoot((dispose) => ({ dispose, values: observe(() => owner.value) }));
  published(first.values, ["before render"]);
  first.dispose();

  owner.value = "between readers";
  const second = root(() => observe(() => owner.value));
  published(second, ["between readers"]);
  owner.value = "updated";
  expect(owner.value).toBe("updated");
  published(second, ["between readers", "updated"]);
  expect(first.values).toEqual(["before render"]);
});

it("publishes error changes without letting recovery clear another writer's identical error", () => {
  const { state, frames } = root(() => {
    const owner = createTestPageState(makeChatHost());
    return { state: owner, frames: observe(() => [owner.lastError, owner.chatError]) };
  });
  const check = (lastError: string | null, chatError: string | null, count: number) => {
    expect(state).toMatchObject({ lastError, chatError });
    flush();
    expect(frames).toHaveLength(count);
    expect(frames.at(-1)).toEqual([lastError, chatError]);
  };
  check(null, null, 1);
  const clear = state.setRecoverableChatError("read failed");
  check("read failed", "read failed", 2);
  state.lastError = "read failed";
  check("read failed", "read failed", 2);
  clear();
  check("read failed", null, 3);
  clear();
  check("read failed", null, 3);
  state.chatError = "another failure";
  check("read failed", "another failure", 4);
});
