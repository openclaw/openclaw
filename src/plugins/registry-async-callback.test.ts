import { expect, it, vi } from "vitest";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
import { markPluginRegistryRetired } from "./registry-lifecycle.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRecord } from "./status.test-helpers.js";

const complete = vi.hoisted(() =>
  vi.fn(async ({ assertPluginCurrent }: { pluginId: string; assertPluginCurrent: () => void }) => {
    assertPluginCurrent();
    return "accepted" as const;
  }),
);
vi.mock("../agents/plugin-async-callback.host.js", () => ({
  completeHostPluginAsyncCallback: complete,
}));

function plugin(id: string) {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createPluginRuntimeMock(),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id });
  builder.registry.plugins.push(record);
  return {
    registry: builder.registry,
    api: builder.createApi(record, { config: {}, registrationMode: "full" }),
  };
}

it("binds restart-completion to the current plugin instance and revokes old generations", async () => {
  const a = plugin("a");
  const b = plugin("b");
  await a.api.asyncToolCallbacks.complete({ token: "opaque", resultText: "done" });
  await b.api.asyncToolCallbacks.complete({ token: "opaque", resultText: "done" });
  expect(complete.mock.calls.map(([call]) => call.pluginId)).toEqual(["a", "b"]);
  markPluginRegistryRetired(a.registry);
  await expect(
    a.api.asyncToolCallbacks.complete({ token: "opaque", resultText: "done" }),
  ).rejects.toThrow("no longer active");
  const rebound = plugin("a");
  await rebound.api.asyncToolCallbacks.complete({ token: "opaque", resultText: "done" });
  expect(complete.mock.calls.at(-1)?.[0].pluginId).toBe("a");
});
