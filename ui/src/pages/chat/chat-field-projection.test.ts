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

it("publishes fields independently while owner reads and array identity stay synchronous", () => {
  const owner = { loading: false, messages: ["first"], unrelated: 0 };
  const { messages, loading } = root(() => {
    expect(projectChatFields(owner, ["loading", "messages"])).toBe(owner);
    return { messages: observe(() => owner.messages), loading: observe(() => owner.loading) };
  });
  flush();
  const next = ["first", "second"];
  owner.messages = next;
  expect(owner.messages).toBe(next);
  expect(messages).toEqual([["first"]]);
  flush();
  expect(messages).toEqual([["first"], ["first", "second"]]);
  expect(messages[1]).toBe(next);
  expect(loading).toEqual([false]);

  owner.messages = next;
  owner.unrelated += 1;
  flush();
  expect(messages).toHaveLength(2);
  expect(loading).toEqual([false]);

  owner.loading = true;
  expect(owner.loading).toBe(true);
  flush();
  expect(loading).toEqual([false, true]);
  expect(messages).toHaveLength(2);
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
  const accessor = Object.getOwnPropertyDescriptor(owner, "owned");
  root(() => projectChatFields(owner));
  expect(owner.callback).toBe(callback);
  expect(Object.getOwnPropertyDescriptor(owner, "owned")).toEqual(accessor);
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
  flush();
  expect(first.values).toEqual(["before render"]);
  first.dispose();

  owner.value = "between readers";
  const second = root(() => observe(() => owner.value));
  flush();
  expect(second).toEqual(["between readers"]);
  owner.value = "updated";
  expect(owner.value).toBe("updated");
  flush();
  expect(second).toEqual(["between readers", "updated"]);
  expect(first.values).toEqual(["before render"]);
});

it("publishes error changes without letting recovery clear another writer's identical error", () => {
  const { state, frames } = root(() => {
    const owner = createTestPageState(makeChatHost());
    return { state: owner, frames: observe(() => [owner.lastError, owner.chatError]) };
  });
  flush();
  const clear = state.setRecoverableChatError("read failed");
  expect(state).toMatchObject({ lastError: "read failed", chatError: "read failed" });
  flush();
  expect(frames).toEqual([
    [null, null],
    ["read failed", "read failed"],
  ]);

  state.lastError = "read failed";
  flush();
  expect(frames).toHaveLength(2);
  clear();
  expect(state).toMatchObject({ lastError: "read failed", chatError: null });
  flush();
  expect(frames.at(-1)).toEqual(["read failed", null]);

  clear();
  flush();
  expect(frames).toHaveLength(3);
  state.chatError = "another failure";
  expect(state.chatError).toBe("another failure");
  flush();
  expect(frames.at(-1)).toEqual(["read failed", "another failure"]);
});
