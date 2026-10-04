import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { SkillBinTrustEntry } from "../infra/exec-approvals.js";
import {
  NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
  NODE_DEVICE_APPS_COMMAND,
} from "../infra/node-commands.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { SkillBinsProvider } from "./invoke.js";
import {
  createNodeHostClient,
  frame,
  holdInvoke,
  mocks,
  prepareNodeHostRuntime,
  startRuntime,
} from "./runtime.test-support.js";

type SkillBinsResponse = { bins: string[] };
type SkillBinsFixture = {
  requests: Array<ReturnType<typeof createDeferred<SkillBinsResponse>>>;
  observed: Map<string, SkillBinTrustEntry[]>;
  expected: SkillBinTrustEntry[];
  response: SkillBinsResponse;
  invoke: (id: string) => Promise<void>;
  expire: () => void;
  disconnect: () => Promise<void>;
};

async function withSkillBinsRuntime(run: (fixture: SkillBinsFixture) => Promise<void>) {
  await withEnvAsync({ PATH: path.dirname(process.execPath) }, async () => {
    const requests: SkillBinsFixture["requests"] = [];
    const observed = new Map<string, SkillBinTrustEntry[]>();
    const invokes: Promise<void>[] = [];
    const name = path.basename(process.execPath);
    const response = { bins: [name] };
    const now = Date.now;
    let elapsed = 0;
    const runtime = await startRuntime(
      createNodeHostClient(() => {
        const request = createDeferred<SkillBinsResponse>();
        requests.push(request);
        return request.promise;
      }),
    );
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + elapsed);
    mocks.handleInvoke.mockImplementation(async (...args: unknown[]) => {
      const request = args[0] as typeof frame;
      const provider = args[2] as SkillBinsProvider;
      observed.set(request.id, await provider.current());
    });
    try {
      await run({
        requests,
        observed,
        expected: [{ name, resolvedPath: fs.realpathSync(process.execPath) }],
        response,
        invoke: (id) => {
          const pending = runtime.invoke({ ...frame, id, command: "system.run" });
          invokes.push(pending);
          return pending;
        },
        expire: () => {
          elapsed += 90_001;
        },
        disconnect: () => runtime.cancelAll(),
      });
    } finally {
      await runtime.cancelAll();
      for (const request of requests) {
        request.resolve({ bins: [] });
      }
      await Promise.allSettled(invokes);
      try {
        await runtime.close();
      } finally {
        mocks.handleInvoke.mockReset();
        clock.mockRestore();
      }
    }
  });
}

async function primeSkillBins(fixture: SkillBinsFixture) {
  const pending = fixture.invoke("prime");
  await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
  expectDefined(fixture.requests[0], "initial skill refresh").resolve(fixture.response);
  await pending;
  expect(fixture.observed.get("prime")).toEqual(fixture.expected);
  fixture.expire();
}

describe("node-host skill-bin cache", () => {
  it.each(["cold", "expired"])("shares a failed %s refresh and permits retry", async (phase) => {
    await withSkillBinsRuntime(async (fixture) => {
      if (phase === "expired") {
        await primeSkillBins(fixture);
      }
      const requestCount = fixture.requests.length + 1;
      const first = fixture.invoke("first");
      const second = fixture.invoke("second");
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(requestCount));
      expectDefined(fixture.requests[requestCount - 1], "failed skill refresh").reject(
        new Error("Gateway unavailable"),
      );
      await Promise.all([first, second]);
      for (const id of ["first", "second"]) {
        expect(fixture.observed.get(id)).toEqual(phase === "expired" ? fixture.expected : []);
      }
      const retry = fixture.invoke("retry");
      const joined = fixture.invoke("joined-retry");
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(requestCount + 1));
      expectDefined(fixture.requests[requestCount], "retried skill refresh").resolve(
        fixture.response,
      );
      await Promise.all([retry, joined]);
      await fixture.invoke("warm");
      for (const id of ["retry", "joined-retry", "warm"]) {
        expect(fixture.observed.get(id)).toEqual(fixture.expected);
      }
      expect(fixture.requests).toHaveLength(requestCount + 1);
    });
  });

  it("keeps pending old-connection results out of the replacement cache", async () => {
    await withSkillBinsRuntime(async (fixture) => {
      const old = fixture.invoke("old");
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(1));
      await fixture.disconnect();
      const replacement = fixture.invoke("replacement");
      await vi.waitFor(() => expect(fixture.requests).toHaveLength(2));
      expectDefined(fixture.requests[0], "retired connection refresh").resolve(fixture.response);
      await old;
      expect(fixture.observed.has("replacement")).toBe(false);
      expectDefined(fixture.requests[1], "replacement connection refresh").resolve({ bins: [] });
      await replacement;
      await fixture.invoke("replacement-warm");
      expect(fixture.observed.get("replacement")).toEqual([]);
      expect(fixture.observed.get("replacement-warm")).toEqual([]);
      expect(fixture.requests).toHaveLength(2);
    });
  });
});

describe("node-host invocation cancellation", () => {
  it("does not admit a queued invocation after its connection is retired", async () => {
    const runtime = await startRuntime();
    const pending = runtime.invoke({ ...frame, command: "system.run" });
    await runtime.cancelAll();
    await pending;
    expect(mocks.handleInvoke).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("cancels a superseded invocation without orphaning its replacement", async () => {
    const first = holdInvoke();
    const second = holdInvoke();
    const runtime = await startRuntime();
    const firstInvoke = runtime.invoke({ ...frame, command: "system.run" });
    await vi.waitFor(() => expect(first.signal).toBeDefined());

    const secondInvoke = runtime.invoke({ ...frame, command: "system.run" });
    await vi.waitFor(() => expect(second.signal).toBeDefined());

    expect(first.signal?.aborted).toBe(true);
    expect(second.signal?.aborted).toBe(false);
    expect(second.io).toBeUndefined();

    first.release();
    await firstInvoke;
    expect(second.signal?.aborted).toBe(false);
    runtime.cancel(frame.id);

    expect(second.signal?.aborted).toBe(true);
    second.release();
    await secondInvoke;
    await runtime.close();
  });

  it.each(["supervisor", "MCP"] as const)(
    "retains %s retirement failure with its retry policy",
    async (owner) => {
      const failure = new Error(`${owner} close failed`);
      const retiring = createDeferred();
      const entered = createDeferred();
      const close = owner === "supervisor" ? mocks.closeWorkerSupervisor : mocks.closeMcp;
      close.mockImplementationOnce(async () => {
        entered.resolve();
        await retiring.promise;
        return undefined;
      });
      const runtime = await startRuntime();
      const closing = runtime.close();
      const observed = expect(closing).rejects.toBe(failure);
      try {
        await entered.promise;
        expect(runtime.close()).toBe(closing);
        retiring.reject(failure);
        await observed;
        expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
        expect(mocks.closeMcp).toHaveBeenCalledOnce();
        if (owner === "supervisor") {
          await expect(runtime.close()).resolves.toBeUndefined();
          expect(mocks.closeWorkerSupervisor).toHaveBeenCalledTimes(2);
        } else {
          await expect(runtime.close()).rejects.toBe(failure);
          expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
        }
        expect(mocks.closeMcp).toHaveBeenCalledOnce();
      } finally {
        retiring.resolve();
        await Promise.allSettled([closing, observed]);
      }
    },
  );

  it("retries failed plugin cleanup on explicit close", async () => {
    const failure = new Error("disconnect cleanup failed");
    mocks.disconnectPlugins.mockRejectedValueOnce(failure);
    const runtime = await startRuntime();
    await expect(runtime.close()).rejects.toBe(failure);
    await expect(runtime.close()).resolves.toBeUndefined();
    expect(mocks.disconnectPlugins).toHaveBeenCalledTimes(2);
    expect(mocks.closeMcp).toHaveBeenCalledOnce();
    expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
  });

  it.each(["close", "cancelAll"] as const)(
    "joins cleanup when %s synchronously reenters close",
    async (transition) => {
      const held = holdInvoke();
      const cleanups: Array<ReturnType<typeof createDeferred<void>>> = [];
      const entered = createDeferred();
      let tearingDown = false;
      mocks.disconnectPlugins.mockImplementation(async () => {
        if (tearingDown) {
          return;
        }
        const cleanup = createDeferred();
        cleanups.push(cleanup);
        entered.resolve();
        await cleanup.promise;
      });
      const runtime = await startRuntime();
      const invoking = runtime.invoke({ ...frame, command: "system.run" });
      let closing: Promise<void> | undefined;
      let observed: Promise<void> | undefined;
      let retiring: Promise<void> | undefined;
      let closed = false;
      const tick = () =>
        new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      try {
        await vi.waitFor(() => expect(held.signal).toBeDefined());
        held.signal?.addEventListener(
          "abort",
          () => {
            closing = runtime.close();
            observed = closing.then(() => {
              closed = true;
            });
          },
          { once: true },
        );
        retiring = runtime[transition]();
        expect(held.signal?.aborted).toBe(true);
        if (transition === "close") {
          expect(closing).toBe(retiring);
        }
        await entered.promise;
        await tick();
        expect(closed).toBe(false);
        for (const cleanup of cleanups) {
          cleanup.resolve();
          await tick();
          if (cleanups.at(-1) !== cleanup) {
            expect(closed).toBe(false);
          }
        }
        await retiring;
        await closing;
        expect(mocks.disconnectPlugins).toHaveBeenCalledTimes(transition === "close" ? 1 : 2);
        expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce();
        expect(mocks.closeMcp).toHaveBeenCalledOnce();
      } finally {
        tearingDown = true;
        for (const cleanup of cleanups) {
          cleanup.resolve();
        }
        held.release();
        await Promise.allSettled([invoking, closing, observed, retiring]);
      }
    },
  );

  it("keeps invoke admission closed after failed idle-worker cleanup until reconnect", async () => {
    const failure = new Error("disconnect cleanup failed");
    mocks.retireIdleWorkers.mockRejectedValueOnce(failure);
    const request = vi.fn(async () => ({}));
    const runtime = await startRuntime(createNodeHostClient(request));
    try {
      const disconnecting = runtime.cancelAll().catch((error: unknown) => error);
      await runtime.invoke(frame);
      expect(await disconnecting).toBe(failure);
      expect(mocks.handleInvoke).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledWith(
        "node.invoke.result",
        expect.objectContaining({
          id: frame.id,
          ok: false,
          error: {
            code: "UNAVAILABLE",
            message: "Node disconnect cleanup failed. Reconnect the node to retry cleanup.",
          },
        }),
      );
      await runtime.cancelAll();
      await runtime.invoke({ ...frame, id: "after-reconnect" });
      expect(mocks.handleInvoke).toHaveBeenCalledOnce();
      expect(mocks.disconnectPlugins).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.close();
    }
  });

  it("aggregates independent supervisor and MCP close failures in owner order", async () => {
    const supervisorError = new Error("supervisor close failed");
    const mcpError = new Error("MCP close failed");
    mocks.closeWorkerSupervisor.mockRejectedValueOnce(supervisorError);
    mocks.closeMcp.mockRejectedValueOnce(mcpError);
    const runtime = await startRuntime();

    const error = await runtime.close().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([supervisorError, mcpError]);
  });

  it("aborts MCP startup before waiting while supervisor retirement runs independently", async () => {
    let startupSignal: AbortSignal | undefined;
    let resolveStartup!: (manager: Awaited<ReturnType<typeof mocks.startMcp>>) => void;
    mocks.startMcp.mockImplementationOnce(async (_servers, deps) => {
      startupSignal = deps?.signal;
      return await new Promise((resolve) => {
        resolveStartup = resolve;
      });
    });
    const runtime = await startRuntime();

    const closing = runtime.close();
    expect(startupSignal?.aborted).toBe(true);
    await vi.waitFor(() => expect(mocks.closeWorkerSupervisor).toHaveBeenCalledOnce());
    resolveStartup({
      descriptors: [],
      callMcpTool: vi.fn(),
      close: mocks.closeMcp,
    });

    await closing;
    expect(mocks.closeMcp).toHaveBeenCalledOnce();
  });
});

describe("node-host desktop manifest", () => {
  it.each([
    { configEnabled: false, nativeEnabled: undefined, ephemeral: false, enabled: false },
    { configEnabled: true, nativeEnabled: false, ephemeral: false, enabled: false },
  ])(
    "honors desktop opt-out from config=$configEnabled and native=$nativeEnabled",
    async ({ configEnabled, nativeEnabled, ephemeral, enabled }) => {
      const prepared = await prepareNodeHostRuntime({
        config: { desktop: { host: { enabled: configEnabled, port: 5901 } } },
        env: { PATH: "/usr/bin" },
        desktopSharingEnabled: nativeEnabled,
        platform: "darwin",
        ephemeral,
      });
      expect(prepared.manifest.commands.includes(NODE_DESKTOP_STREAM_COMMAND)).toBe(enabled);
      const runtime = prepared.start({ client: createNodeHostClient(async () => ({ bins: [] })) });
      try {
        await runtime.invoke({ ...frame, command: NODE_DESKTOP_STREAM_COMMAND });
        expect(mocks.handleInvoke).toHaveBeenLastCalledWith(
          expect.anything(),
          expect.anything(),
          expect.anything(),
          expect.anything(),
          expect.objectContaining({ desktopHostConfig: { enabled, port: 5901 } }),
        );
      } finally {
        await runtime.close();
      }
    },
  );

  it("emits desktop statuses without control-channel heartbeats", async () => {
    const runtime = await startRuntime();
    await runtime.invoke({ ...frame, command: NODE_DESKTOP_STREAM_COMMAND });

    expect(mocks.progressStartHeartbeats).not.toHaveBeenCalled();
    const lastCall = mocks.handleInvoke.mock.calls.at(-1) as unknown[] | undefined;
    const invokeRuntime = lastCall?.[4] as
      | {
          emitProgress?: (text: string) => Promise<void>;
        }
      | undefined;
    await invokeRuntime?.emitProgress?.("attached\n");
    expect(mocks.progressWrite).toHaveBeenCalledWith("attached\n");
    await runtime.close();
  });
});

async function withFramedInvoke(
  run: (
    runtime: Awaited<ReturnType<typeof startRuntime>>,
    held: ReturnType<typeof holdInvoke>,
  ) => Promise<void>,
) {
  const held = holdInvoke();
  const runtime = await startRuntime();
  const invoking = runtime.invoke(frame);
  try {
    await vi.waitFor(() => expect(held.io).toBeDefined());
    await run(runtime, held);
  } finally {
    held.release();
    await invoking;
    await runtime.close();
  }
}

describe("node-host invoke input dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers framed readiness before exchanging binary messages", async () => {
    await withFramedInvoke(async (runtime, held) => {
      expect(mocks.progressWrite).not.toHaveBeenCalled();

      const received = vi.fn();
      const unsubscribe = held.io?.frames?.onMessage(received);

      await vi.waitFor(() =>
        expect(mocks.progressWrite).toHaveBeenCalledWith(JSON.stringify({ v: 1, kind: "ready" })),
      );
      await held.io?.frames?.send(Uint8Array.from([0, 255]));
      runtime.handleInput(frame.id, 0, mocks.progressWrite.mock.calls[1]![0]);
      expect(received).toHaveBeenCalledExactlyOnceWith(Uint8Array.from([0, 255]));
      expect(unsubscribe).toEqual(expect.any(Function));
      unsubscribe?.();
    });
  });

  it("aborts the invocation when its framed plugin message listener fails", async () => {
    await withFramedInvoke(async (runtime, held) => {
      held.io?.frames?.onMessage(() => {
        throw new Error("plugin message rejected");
      });
      await vi.waitFor(() => expect(mocks.progressWrite).toHaveBeenCalledOnce());

      expect(() =>
        runtime.handleInput(
          frame.id,
          0,
          JSON.stringify({
            v: 1,
            kind: "data",
            message: 0,
            index: 0,
            last: true,
            data: "eA==",
          }),
        ),
      ).not.toThrow();
      expect(held.io?.signal.aborted).toBe(true);
      expect(held.io?.signal.reason).toEqual(
        expect.objectContaining({ message: "plugin message rejected" }),
      );
      await expect(held.io?.frames?.send(Uint8Array.from([1]))).rejects.toThrow(/closed/i);
    });
  });

  it("delivers buffered and live input in sequence without replaying duplicates", async () => {
    await withFramedInvoke(async (runtime, held) => {
      runtime.handleInput("unknown", 0, "unknown");
      runtime.handleInput(frame.id, 0, "first");
      runtime.handleInput(frame.id, 1, "second");
      const input = vi.fn();
      held.io?.onInput(input);
      expect(input.mock.calls).toEqual([["first"], ["second"]]);
      runtime.handleInput(frame.id, 1, "duplicate");
      runtime.handleInput(frame.id, 3, "gap");
      runtime.handleInput(frame.id, 4, "next");
      expect(input.mock.calls).toEqual([["first"], ["second"], ["gap"], ["next"]]);
    });
  });

  it("aborts without delivering partial input when the pre-spawn buffer overflows", async () => {
    await withFramedInvoke(async (runtime, held) => {
      const chunk = "x".repeat(16 * 1024 - 1);

      for (let seq = 0; seq < 5; seq += 1) {
        runtime.handleInput(frame.id, seq, `${seq}${chunk}`);
      }
      expect(held.io?.signal.aborted).toBe(true);
      const input = vi.fn();
      held.io?.onInput(input);
      expect(input).not.toHaveBeenCalled();
      runtime.handleInput(frame.id, 5, "continued");
      expect(input).not.toHaveBeenCalled();
    });
  });
});

describe("node-host duplex capability selection", () => {
  it("advertises duplex plugin commands without enabling native agent runs", async () => {
    const prepared = await prepareNodeHostRuntime({
      config: { nodeHost: { skills: { enabled: false } } },
      env: { PATH: "/usr/bin" },
    });

    expect(prepared.manifest.commands).toContain("test.duplex");
    expect(prepared.manifest.commands).not.toContain(NODE_AGENT_CLI_CLAUDE_RUN_COMMAND);
  });
});

describe("installed application command advertisement", () => {
  it("advertises device.apps only when sharing is enabled on macOS", async () => {
    const disabled = await prepareNodeHostRuntime({
      config: { nodeHost: { skills: { enabled: false } } },
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      installedAppsSharingEnabled: false,
    });
    const enabled = await prepareNodeHostRuntime({
      config: { nodeHost: { skills: { enabled: false } } },
      env: { PATH: "/usr/bin" },
      platform: "darwin",
      installedAppsSharingEnabled: true,
    });
    const nonDarwin = await prepareNodeHostRuntime({
      config: { nodeHost: { skills: { enabled: false } } },
      env: { PATH: "/usr/bin" },
      platform: "linux",
      installedAppsSharingEnabled: true,
    });

    expect(disabled.manifest.commands).not.toContain(NODE_DEVICE_APPS_COMMAND);
    expect(enabled.manifest.commands).toContain(NODE_DEVICE_APPS_COMMAND);
    expect(nonDarwin.manifest.commands).not.toContain(NODE_DEVICE_APPS_COMMAND);
  });
});
