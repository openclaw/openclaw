import { describe, expect, it, vi } from "vitest";
import { cloneHookIsolationValue, HookIsolationError } from "./hook-isolation.js";
import { createHookRunnerWithRegistry } from "./hooks.test-fixtures.js";

describe("native-clone shared-memory scan", () => {
  it("scans materialized plain fields without descriptor reads and preserves clone cycles", () => {
    let getters = 0;
    const leaf = { nested: [1, 2] };
    const input: { leaf: typeof leaf; self?: unknown; getter?: typeof leaf } = { leaf };
    input.self = input;
    Object.defineProperty(input, "getter", {
      enumerable: true,
      get: () => {
        getters++;
        return leaf;
      },
    });
    const descriptors = vi.spyOn(Object, "getOwnPropertyDescriptor");
    try {
      const clone = cloneHookIsolationValue("before_prompt_build", input);
      // Count before assertion diagnostics inspect the accessor-bearing source.
      expect(getters).toBe(1);
      expect(descriptors).not.toHaveBeenCalled();
      expect(clone === input).toBe(false);
      expect(clone.self).toBe(clone);
      expect(clone.getter).toBe(clone.leaf);
    } finally {
      descriptors.mockRestore();
    }
  });
  it.each(["object", "map-key", "map-value", "set", "view", "getter"])(
    "rejects shared memory in %s",
    (kind) => {
      const shared = new SharedArrayBuffer(8);
      const fixtures = {
        object: { nested: [shared] },
        "map-key": new Map([[shared, 1]]),
        "map-value": new Map([[1, shared]]),
        set: new Set([shared]),
        view: { nested: new Uint8Array(shared) },
        getter: {
          get value() {
            return shared;
          },
        },
      };
      expect(() =>
        cloneHookIsolationValue("before_prompt_build", fixtures[kind as keyof typeof fixtures]),
      ).toThrow(HookIsolationError);
    },
  );
  it("accepts ordinary array buffers, maps and sets", () => {
    const input = new Map([[new Set([1]), new Uint8Array(4)]]);
    expect(cloneHookIsolationValue("before_prompt_build", input)).toEqual(input);
  });
  it("retains native and custom-prototype clone semantics", () => {
    class Custom {
      value = { nested: [1] };
    }
    const input = { error: new Error("failure"), date: new Date(123), custom: new Custom() };
    const clone = cloneHookIsolationValue("before_prompt_build", input);
    expect(clone.error.message).toBe("failure");
    expect(clone.date.getTime()).toBe(123);
    expect(Object.getPrototypeOf(clone.custom)).toBe(Object.prototype);
    expect(clone.custom.value).toEqual(input.custom.value);
    expect(clone.custom.value === input.custom.value).toBe(false);
    expect(() =>
      cloneHookIsolationValue("before_tool_call", {
        memory: new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true }),
      }),
    ).toThrow(HookIsolationError);
  });

  it("isolates actual projected prompt and before-tool consumers", async () => {
    const message = { role: "user", content: [{ type: "text", text: "original" }], timestamp: 1 };
    const params = { nested: { values: [1, 2] } };
    const promptHandler = vi.fn((event) => {
      event.messages[0].content[0].text = "plugin-only";
      return {};
    });
    const toolHandler = vi.fn((event) => {
      event.params.nested.values.push(3);
      return {};
    });
    const { runner } = createHookRunnerWithRegistry([
      { hookName: "before_prompt_build", handler: promptHandler },
      { hookName: "before_tool_call", handler: toolHandler },
    ]);
    await runner.runBeforePromptBuild({ prompt: "hello", messages: [message] }, {});
    await runner.runBeforeToolCall({ toolName: "read", params }, { toolName: "read" });
    expect(promptHandler).toHaveBeenCalledOnce();
    expect(toolHandler).toHaveBeenCalledOnce();
    expect(message.content[0]!.text).toBe("original");
    expect(params.nested.values).toEqual([1, 2]);
  });
});
