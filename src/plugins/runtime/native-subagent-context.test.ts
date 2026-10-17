import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  nativeSubagentRuntime,
  withNativeSubagentRequest,
  withNativeSubagentRuntimeGuard,
} from "./native-subagent-context.js";
import type { NativeSubagentRuntime } from "./types-native-subagent.js";

function fixture() {
  const spawn = vi.fn<NativeSubagentRuntime["spawn"]>().mockResolvedValue({
    runId: "child-run",
    childSessionKey: "agent:main:subagent:child",
    completionMode: "collect",
  });
  const collect = vi
    .fn<NativeSubagentRuntime["collect"]>()
    .mockResolvedValue({ completed: [], pending: ["child-run"] });
  return { spawn, collect };
}
const params = { requestId: "first", task: "Review the change" };
const guard = { pluginId: "test-plugin", assertCurrent() {} };

describe("native subagent requester binding", () => {
  it("rejects calls without both a host request and a plugin runtime", async () => {
    await expect(nativeSubagentRuntime.spawn(params)).rejects.toThrow("requester-bound");
    const runtime = fixture();
    await withNativeSubagentRequest(
      () => runtime,
      async () => {
        await expect(nativeSubagentRuntime.spawn(params)).rejects.toThrow("requester-bound");
      },
    );
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it.each(["request", "plugin"] as const)(
    "keeps identical calls in separate %s bindings",
    async (boundary) => {
      const ready = createDeferred();
      const runtimes = [fixture(), fixture()];
      const invoke = (index: number) =>
        withNativeSubagentRuntimeGuard(
          { ...guard, pluginId: boundary === "plugin" ? String(index) : guard.pluginId },
          async () => {
            if (index === 0) {
              await ready.promise;
            } else {
              ready.resolve();
            }
            await nativeSubagentRuntime.spawn(params);
          },
        );
      if (boundary === "request") {
        await Promise.all(
          runtimes.map((runtime, index) =>
            withNativeSubagentRequest(
              () => runtime,
              () => invoke(index),
            ),
          ),
        );
      } else {
        await withNativeSubagentRequest(
          (source) => expectDefined(runtimes[Number(source.pluginId)], "plugin runtime fixture"),
          () => Promise.all([invoke(0), invoke(1)]),
        );
      }
      for (const runtime of runtimes) {
        expect(runtime.spawn).toHaveBeenCalledExactlyOnceWith(params);
      }
    },
  );

  it("aborts the request scope and rejects detached calls after a handler exits", async () => {
    const gate = createDeferred();
    const runtime = fixture();
    let detached: Promise<unknown> | undefined;
    let signal: AbortSignal | undefined;
    await withNativeSubagentRequest(
      (source) => {
        signal = source.signal;
        return runtime;
      },
      () =>
        withNativeSubagentRuntimeGuard(guard, async () => {
          await nativeSubagentRuntime.collect({ ids: ["child-run"], timeoutSeconds: 0 });
          detached = gate.promise.then(() => nativeSubagentRuntime.spawn(params));
        }),
    );
    expect(signal?.aborted).toBe(true);
    gate.resolve();
    await expect(detached).rejects.toThrow("requester-bound");
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it("rechecks plugin lifecycle after awaited request preparation", async () => {
    const gate = createDeferred<NativeSubagentRuntime>();
    const runtime = fixture();
    let active = true;
    const work = withNativeSubagentRequest(
      () => gate.promise,
      () =>
        withNativeSubagentRuntimeGuard(
          {
            pluginId: "test-plugin",
            assertCurrent() {
              if (!active) {
                throw new Error("plugin retired");
              }
            },
          },
          () => nativeSubagentRuntime.spawn(params),
        ),
    );
    active = false;
    gate.resolve(runtime);
    await expect(work).rejects.toThrow("plugin retired");
    expect(runtime.spawn).not.toHaveBeenCalled();
  });
});
