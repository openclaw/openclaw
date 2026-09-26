// Tests channel runtime context assembly and hook inputs.
import { describe, expect, it, vi } from "vitest";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import {
  createTaskScopedChannelRuntime,
  getChannelRuntimeContext,
  registerChannelRuntimeContext,
  watchChannelRuntimeContexts,
} from "./channel-runtime-context.js";

const slack = { channelId: "slack", accountId: "default", capability: "approval.native" };
const matrix = { ...slack, channelId: "matrix" };

describe("channel runtime context helpers", () => {
  it("returns inert helpers when no channel runtime exists", () => {
    expect(
      registerChannelRuntimeContext({
        ...slack,
        context: { ok: true },
      }),
    ).toBeNull();
    expect(
      getChannelRuntimeContext({
        ...slack,
      }),
    ).toBeUndefined();
    expect(
      watchChannelRuntimeContexts({
        ...slack,
        onEvent: vi.fn(),
      }),
    ).toBeNull();

    const scoped = createTaskScopedChannelRuntime({});
    expect(scoped.channelRuntime).toBeUndefined();
    expect(scoped.dispose()).toBeUndefined();
  });

  it.each([
    { first: "task", throws: false },
    { first: "lease", throws: false },
    { first: "task", throws: true },
    { first: "lease", throws: true },
  ])("disposes a registration once with $first first and throws=$throws", ({ first, throws }) => {
    const channelRuntime = createRuntimeChannel();
    const dispose = vi.fn(() => {
      if (throws) {
        throw new Error("cleanup failed");
      }
    });
    vi.spyOn(channelRuntime.runtimeContexts, "register").mockReturnValue({ dispose });
    const scoped = createTaskScopedChannelRuntime({ channelRuntime });
    const lease = scoped.channelRuntime!.runtimeContexts.register({
      channelId: "slack",
      capability: "approval.native",
      context: {},
    });
    const finish = first === "task" ? scoped.dispose : lease.dispose;
    if (throws) {
      expect(finish).toThrow("cleanup failed");
    } else {
      finish();
    }
    lease.dispose();
    scoped.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes only task-scoped registrations", () => {
    const channelRuntime = createRuntimeChannel();
    const onEvent = vi.fn();
    const unsubscribe = watchChannelRuntimeContexts({
      channelRuntime,
      ...slack,
      onEvent,
    });
    const persistentLease = registerChannelRuntimeContext({
      channelRuntime,
      ...matrix,
      context: { client: "matrix" },
    });
    const scoped = createTaskScopedChannelRuntime({ channelRuntime });

    registerChannelRuntimeContext({
      channelRuntime: scoped.channelRuntime,
      ...slack,
      context: { app: "slack" },
    });

    expect(
      getChannelRuntimeContext({
        channelRuntime,
        ...slack,
      }),
    ).toEqual({ app: "slack" });
    expect(
      getChannelRuntimeContext({
        channelRuntime,
        ...matrix,
      }),
    ).toEqual({ client: "matrix" });

    scoped.dispose();

    expect(
      getChannelRuntimeContext({
        channelRuntime,
        ...slack,
      }),
    ).toBeUndefined();
    expect(
      getChannelRuntimeContext({
        channelRuntime,
        ...matrix,
      }),
    ).toEqual({ client: "matrix" });
    expect(onEvent.mock.calls).toEqual([
      [
        {
          type: "registered",
          key: slack,
          context: { app: "slack" },
        },
      ],
      [
        {
          type: "unregistered",
          key: slack,
        },
      ],
    ]);

    persistentLease?.dispose();
    unsubscribe?.();
  });
});
