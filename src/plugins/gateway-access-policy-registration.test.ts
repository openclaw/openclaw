import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it, onTestFinished, vi } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { bindPluginGatewayAccessPolicy } from "./gateway-access-policy-registration.js";
import { createOwnedTestInstance } from "./plugin-instance.test-support.js";
import { pluginRetentionEntrypoints } from "./retention-runtime.test-support.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

it("reuses the assertion callback while checking live authority inside each fresh plugin scope", () => {
  const instance = createOwnedTestInstance("access-policy");
  const run = vi.spyOn(instance, "run");
  const scopes: ReturnType<typeof getPluginRuntimeGatewayRequestScope>[] = [];
  const revoked = new AbortController();
  const source = {
    signal: new AbortController().signal,
    get assertCurrent(): () => void {
      scopes.push(getPluginRuntimeGatewayRequestScope());
      return function (this: unknown) {
        expect(this).toBe(source);
        revoked.signal.throwIfAborted();
      };
    },
  };
  const policy = bindPluginGatewayAccessPolicy({ authorize: () => source }, instance);
  const authority = policy.authorize({
    config: {},
    profile: { profileId: "person", emails: [], assignedRole: null },
    requiredByRole: false,
  })!;
  run.mockClear();
  const definitions = vi.spyOn(Object, "defineProperty");
  onTestFinished(() => definitions.mockRestore());
  for (let index = 0; index < 1_000; index++) {
    authority.assertCurrent();
  }
  const descriptors = definitions.mock.calls.filter(([, key]) => key === "pluginRegistry");
  expect(new Set(descriptors.map((call) => call[2])).size).toBe(1);
  scopes[0]!.pluginRegistry = undefined;
  expect(scopes[1]?.pluginRegistry).toBe(instance.owner?.registry);
  revoked.abort(new Error("grant revoked"));
  expect(authority.assertCurrent).toThrow("grant revoked");
  expect(source.signal.aborted).toBe(false);
  expect(new Set(run.mock.calls.map(([callback]) => callback)).size).toBe(1);
  expect(new Set(scopes).size).toBe(1_001);
  expect(scopes.every((scope) => scope?.pluginId === instance.pluginId)).toBe(true);
  instance.quiesce();
  expect(authority.assertCurrent).toThrow("reloaded or disabled");
});

it.each(["retirement", "live-grant"])(
  "preserves native registered access-signal ownership through %s",
  async (scenario) => {
    const worker = resolveRuntimeWorkerUrl(pluginRetentionEntrypoints.accessPolicy);
    await promisify(execFile)(
      process.execPath,
      ["--expose-gc", ...resolveRuntimeWorkerArgv(worker), scenario],
      { timeout: 20_000 },
    );
  },
  25_000,
);
