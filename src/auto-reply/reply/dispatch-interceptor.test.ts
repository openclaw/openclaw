import { describe, expect, it, vi } from "vitest";
import type {
  DispatchInterceptorContext,
  DispatchInterceptorPlugin,
  InterceptorOutputHandler,
} from "../../plugins/types.js";

describe("DispatchInterceptorPlugin contract", () => {
  it("passes through when interceptor returns intercepted: false", async () => {
    const interceptor: DispatchInterceptorPlugin = {
      async intercept() {
        return { intercepted: false };
      },
    };
    const output: InterceptorOutputHandler = {
      sendBlock: vi.fn(),
      sendStreamChunk: vi.fn(),
      sendStreamDone: vi.fn(),
    };
    const result = await interceptor.intercept("hello", {}, output);
    expect(result.intercepted).toBe(false);
    expect(output.sendBlock).not.toHaveBeenCalled();
  });

  it("blocks and sends message when interceptor returns intercepted: true", async () => {
    const interceptor: DispatchInterceptorPlugin = {
      async intercept(_text, _ctx, output) {
        output.sendBlock("Content blocked.");
        return { intercepted: true };
      },
    };
    const output: InterceptorOutputHandler = {
      sendBlock: vi.fn(),
      sendStreamChunk: vi.fn(),
      sendStreamDone: vi.fn(),
    };
    const result = await interceptor.intercept("bad content", {}, output);
    expect(result.intercepted).toBe(true);
    expect(output.sendBlock).toHaveBeenCalledWith("Content blocked.");
  });

  it("supports streaming output via sendStreamChunk and sendStreamDone", async () => {
    const interceptor: DispatchInterceptorPlugin = {
      async intercept(_text, _ctx, output) {
        output.sendStreamChunk("Sorry, ");
        output.sendStreamChunk("this content ");
        output.sendStreamChunk("is not allowed.");
        output.sendStreamDone();
        return { intercepted: true };
      },
    };
    const output: InterceptorOutputHandler = {
      sendBlock: vi.fn(),
      sendStreamChunk: vi.fn(),
      sendStreamDone: vi.fn(),
    };
    const result = await interceptor.intercept("bad content", {}, output);
    expect(result.intercepted).toBe(true);
    expect(output.sendStreamChunk).toHaveBeenCalledTimes(3);
    expect(output.sendStreamDone).toHaveBeenCalledTimes(1);
  });

  it("receives context fields from dispatch", async () => {
    let receivedContext: DispatchInterceptorContext | undefined;
    const interceptor: DispatchInterceptorPlugin = {
      async intercept(_text, ctx) {
        receivedContext = ctx;
        return { intercepted: false };
      },
    };
    const output: InterceptorOutputHandler = {
      sendBlock: vi.fn(),
      sendStreamChunk: vi.fn(),
      sendStreamDone: vi.fn(),
    };
    await interceptor.intercept(
      "test",
      { sessionKey: "s1", channelId: "telegram", userId: "u1" },
      output,
    );
    expect(receivedContext).toEqual({
      sessionKey: "s1",
      channelId: "telegram",
      userId: "u1",
    });
  });

  it("runs multiple interceptors in sequence until one intercepts", async () => {
    const calls: string[] = [];
    const first: DispatchInterceptorPlugin = {
      async intercept() {
        calls.push("first");
        return { intercepted: false };
      },
    };
    const second: DispatchInterceptorPlugin = {
      async intercept(_text, _ctx, output) {
        calls.push("second");
        output.sendBlock("Blocked by second.");
        return { intercepted: true };
      },
    };
    const third: DispatchInterceptorPlugin = {
      async intercept() {
        calls.push("third");
        return { intercepted: false };
      },
    };

    const interceptors = [first, second, third];
    const output: InterceptorOutputHandler = {
      sendBlock: vi.fn(),
      sendStreamChunk: vi.fn(),
      sendStreamDone: vi.fn(),
    };

    for (const interceptor of interceptors) {
      const result = await interceptor.intercept("test", {}, output);
      if (result.intercepted) {
        break;
      }
    }

    expect(calls).toEqual(["first", "second"]);
    expect(output.sendBlock).toHaveBeenCalledWith("Blocked by second.");
  });
});
