import { createEffect, createRoot, flush } from "solid-js";
import { expect, it } from "vitest";
import { projectChatFields } from "./chat-field-projection.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createTestPageState } from "./chat-page-state.test-support.ts";

it("publishes fields independently while owner reads and array identity stay synchronous", () => {
  const owner = { loading: false, messages: ["first"], unrelated: 0 };
  const messages: string[][] = [];
  const loading: boolean[] = [];
  const dispose = createRoot((stop) => {
    expect(projectChatFields(owner, ["loading", "messages"])).toBe(owner);
    createEffect(
      () => owner.messages,
      (value) => {
        messages.push(value);
      },
    );
    createEffect(
      () => owner.loading,
      (value) => {
        loading.push(value);
      },
    );
    return stop;
  });
  try {
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
  } finally {
    dispose();
  }
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
  const dispose = createRoot((stop) => {
    projectChatFields(owner);
    return stop;
  });
  try {
    expect(owner.callback).toBe(callback);
    expect(Object.getOwnPropertyDescriptor(owner, "owned")).toEqual(accessor);
    owner.owned = "second";
    expect(ownedValue).toBe("second");
    const replacement = () => "replacement";
    owner.callback = replacement;
    expect(owner.callback).toBe(replacement);
    flush();
    expect(owner.callback()).toBe("replacement");
  } finally {
    dispose();
  }
});

it("publishes error changes without letting recovery clear another writer's identical error", () => {
  const frames: Array<{ lastError: string | null; chatError: string | null }> = [];
  const { state, dispose } = createRoot((stop) => {
    const createdState = createTestPageState(makeChatHost());
    createEffect(
      () => ({ lastError: createdState.lastError, chatError: createdState.chatError }),
      (value) => {
        frames.push(value);
      },
    );
    return { state: createdState, dispose: stop };
  });
  try {
    flush();
    const clear = state.setRecoverableChatError("read failed");
    expect(state.lastError).toBe("read failed");
    expect(state.chatError).toBe("read failed");
    flush();
    expect(frames).toEqual([
      { lastError: null, chatError: null },
      { lastError: "read failed", chatError: "read failed" },
    ]);

    state.lastError = "read failed";
    flush();
    expect(frames).toHaveLength(2);
    clear();
    expect(state.lastError).toBe("read failed");
    expect(state.chatError).toBeNull();
    flush();
    expect(frames.at(-1)).toEqual({ lastError: "read failed", chatError: null });

    clear();
    flush();
    expect(frames).toHaveLength(3);
    state.chatError = "another failure";
    expect(state.chatError).toBe("another failure");
    flush();
    expect(frames.at(-1)).toEqual({ lastError: "read failed", chatError: "another failure" });
  } finally {
    dispose();
  }
});
