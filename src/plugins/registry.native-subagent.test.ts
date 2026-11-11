import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { revokePluginRecord } from "./registry-lifecycle.js";
import {
  createOwnershipRecord,
  createOwnershipSubagent,
} from "./registry-ownership.test-support.js";
import { createRuntimeTestRegistry } from "./registry-runtime.test-helpers.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
import {
  nativeSubagentRuntime,
  type NativeSubagentRuntimeGuard,
  withNativeSubagentRequest,
} from "./runtime/native-subagent-context.js";
import type { NativeSubagentRuntime } from "./runtime/types-native-subagent.js";

const request = { requestId: "review", task: "Review this change" };
const listed = {
  runId: "child",
  childSessionKey: "agent:main:subagent:child",
  requestId: "review",
  status: "running" as const,
};

function fixture(native: NativeSubagentRuntime = nativeSubagentRuntime) {
  const runtime = createPluginRuntime();
  runtime.subagent = { ...createOwnershipSubagent("legacy"), native };
  const builder = createRuntimeTestRegistry(runtime);
  const record = createOwnershipRecord("controller");
  const backend = {
    spawn: vi.fn<NativeSubagentRuntime["spawn"]>(async () => ({
      runId: "child",
      childSessionKey: "agent:main:subagent:child",
      completionMode: "collect",
    })),
    collect: vi.fn(async () => ({ completed: [], pending: ["child"] })),
    list: vi.fn(async () => [listed]),
  } satisfies NativeSubagentRuntime;
  return { builder, record, backend };
}

describe("plugin native subagent admission", () => {
  it.each(["discovery", "tool-discovery", "setup-runtime"] as const)(
    "rejects %s mode without entering the native backend",
    async (registrationMode) => {
      const { builder, record, backend } = fixture();
      const api = builder.createApi(record, { config: {}, registrationMode });
      await withNativeSubagentRequest(
        () => backend,
        async () => {
          await expect(api.runtime.subagent.native!.spawn(request)).rejects.toThrow(
            "full registration mode",
          );
          await expect(api.runtime.subagent.native!.collect({ ids: ["child"] })).rejects.toThrow(
            "full registration mode",
          );
          await expect(api.runtime.subagent.native!.list!()).rejects.toThrow(
            "full registration mode",
          );
        },
      );
      expect(backend.spawn).not.toHaveBeenCalled();
      expect(backend.collect).not.toHaveBeenCalled();
      expect(backend.list).not.toHaveBeenCalled();
      expect(await api.runtime.subagent.waitForRun({ runId: "legacy" })).toEqual({ status: "ok" });
    },
  );

  it("lists the plugin's native children through the scoped runtime", async () => {
    const { builder, record, backend } = fixture();
    const api = builder.createApi(record, { config: {} });
    const list = expectDefined(api.runtime.subagent.native?.list, "native list");
    const scopedPluginIds: Array<string | undefined> = [];
    backend.list.mockImplementation(async () => {
      scopedPluginIds.push(getPluginRuntimeGatewayRequestScope()?.pluginId);
      return [listed];
    });
    const create = vi.fn(() => backend);
    await withNativeSubagentRequest(create, async () => {
      await expect(list({ status: "running" })).resolves.toEqual([listed]);
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ pluginId: "controller" }));
    expect(backend.list).toHaveBeenCalledWith({ status: "running" });
    // The host listing runs under the calling plugin's runtime scope.
    expect(scopedPluginIds).toEqual(["controller"]);
  });

  it("omits listing when the host native runtime has none", () => {
    const { builder, record } = fixture({
      spawn: vi.fn<NativeSubagentRuntime["spawn"]>(),
      collect: vi.fn<NativeSubagentRuntime["collect"]>(),
    });
    const native = builder.createApi(record, { config: {} }).runtime.subagent.native;
    expect(native).toHaveProperty("spawn");
    expect(native).not.toHaveProperty("list");
  });

  it.each<[string, (native: NativeSubagentRuntime) => () => Promise<unknown>]>([
    ["spawn", (native) => () => native.spawn(request)],
    ["list", (native) => expectDefined(native.list, "native list")],
  ])(
    "rechecks the actual registry owner after asynchronous preparation (%s)",
    async (_operation, bind) => {
      const { builder, record, backend } = fixture();
      const api = builder.createApi(record, { config: {} });
      const invoke = bind(expectDefined(api.runtime.subagent.native, "native runtime"));
      const entered = createDeferred();
      const resume = createDeferred<NativeSubagentRuntime>();
      const pending = withNativeSubagentRequest(
        () => {
          entered.resolve();
          return resume.promise;
        },
        () => invoke(),
      );
      // A call rejected before preparation must fail here, not wait for preparation.
      await Promise.race([entered.promise, pending]);
      revokePluginRecord(builder.registry, record);
      resume.resolve(backend);
      await expect(pending).rejects.toThrow('Plugin "controller" runtime is no longer active.');
      expect(backend.spawn).not.toHaveBeenCalled();
      expect(backend.list).not.toHaveBeenCalled();
    },
  );

  it("refuses listing once the requester invocation has ended", async () => {
    const { builder, record, backend } = fixture();
    const api = builder.createApi(record, { config: {} });
    const list = expectDefined(api.runtime.subagent.native?.list, "native list");
    const resume = createDeferred<NativeSubagentRuntime>();
    let pending: Promise<unknown> | undefined;
    await withNativeSubagentRequest(
      () => resume.promise,
      async () => {
        pending = list();
      },
    );
    resume.resolve(backend);
    await expect(pending).rejects.toThrow("Native subagent request is no longer active.");
    await expect(list()).rejects.toThrow("requester-bound invocation");
    expect(backend.list).not.toHaveBeenCalled();
  });

  it("gives another plugin its own native runtime in the same invocation", async () => {
    const { builder, record, backend } = fixture();
    const controller = builder.createApi(record, { config: {} }).runtime.subagent.native;
    const observer = builder.createApi(createOwnershipRecord("observer"), { config: {} }).runtime
      .subagent.native;
    const observerBackend = { ...backend, list: vi.fn(async () => []) };
    const create = vi.fn((guard: NativeSubagentRuntimeGuard) =>
      guard.pluginId === "controller" ? backend : observerBackend,
    );
    await withNativeSubagentRequest(create, async () => {
      await expect(expectDefined(controller?.list, "controller list")()).resolves.toEqual([listed]);
      await expect(expectDefined(observer?.list, "observer list")()).resolves.toEqual([]);
    });
    expect(create.mock.calls.map(([guard]) => guard.pluginId)).toEqual(["controller", "observer"]);
    expect(backend.list).toHaveBeenCalledTimes(1);
  });
});
