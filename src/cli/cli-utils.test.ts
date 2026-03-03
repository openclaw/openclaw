import { describe, expect, it, vi } from "vitest";
import { resolveOptionFromCommand, runCommandWithRuntime, withManager } from "./cli-utils.js";

describe("withManager", () => {
  it("runs command and closes manager when manager lookup succeeds", async () => {
    const manager = { id: "mgr-1" };
    const run = vi.fn(async () => {});
    const close = vi.fn(async () => {});

    await withManager({
      getManager: async () => ({ manager }),
      onMissing: vi.fn(),
      run,
      close,
    });

    expect(run).toHaveBeenCalledWith(manager);
    expect(close).toHaveBeenCalledWith(manager);
  });

  it("calls onMissing and skips run/close when manager is absent", async () => {
    const onMissing = vi.fn();
    const run = vi.fn(async () => {});
    const close = vi.fn(async () => {});

    await withManager({
      getManager: async () => ({ manager: null, error: "missing manager" }),
      onMissing,
      run,
      close,
    });

    expect(onMissing).toHaveBeenCalledWith("missing manager");
    expect(run).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  it("reports close errors through onCloseError", async () => {
    const manager = { id: "mgr-2" };
    const closeError = new Error("close failed");
    const onCloseError = vi.fn();

    await withManager({
      getManager: async () => ({ manager }),
      onMissing: vi.fn(),
      run: async () => {},
      close: async () => {
        throw closeError;
      },
      onCloseError,
    });

    expect(onCloseError).toHaveBeenCalledWith(closeError);
  });
});

describe("runCommandWithRuntime", () => {
  it("does nothing on successful action completion", async () => {
    const runtime = {
      error: vi.fn(),
      exit: vi.fn(),
    };
    await runCommandWithRuntime(runtime, async () => {});
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("writes runtime error and exits with code 1 when action throws", async () => {
    const runtime = {
      error: vi.fn(),
      exit: vi.fn(),
    };
    await runCommandWithRuntime(runtime, async () => {
      throw new Error("boom");
    });
    expect(runtime.error).toHaveBeenCalledWith("Error: boom");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });

  it("delegates thrown errors to onError override when provided", async () => {
    const runtime = {
      error: vi.fn(),
      exit: vi.fn(),
    };
    const onError = vi.fn();

    await runCommandWithRuntime(
      runtime,
      async () => {
        throw new Error("custom");
      },
      onError,
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});

describe("resolveOptionFromCommand", () => {
  it("resolves options from command chain nearest-first", () => {
    const root = {
      opts: () => ({ profile: "root", verbose: true }),
      parent: undefined,
    };
    const child = {
      opts: () => ({ profile: "child" }),
      parent: root,
    };

    expect(resolveOptionFromCommand<string>(child as never, "profile")).toBe("child");
    expect(resolveOptionFromCommand<boolean>(child as never, "verbose")).toBe(true);
    expect(resolveOptionFromCommand<string>(child as never, "missing")).toBeUndefined();
  });
});
