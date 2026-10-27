import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { bindPluginGatewayAccessPolicy } from "./gateway-access-policy-registration.js";
import { createOwnedTestInstance } from "./plugin-instance.test-support.js";
import { pluginRetentionEntrypoints } from "./retention-runtime.test-support.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

it("reuses the assertion callback while checking live authority inside each fresh plugin scope", () => {
  const instance = createOwnedTestInstance("access-policy");
  const run = vi.spyOn(instance, "run");
  const scopes: unknown[] = [];
  let revoked = false;
  const source = {
    signal: new AbortController().signal,
    get assertCurrent(): () => void {
      const scope = getPluginRuntimeGatewayRequestScope();
      expect(scope?.pluginId).toBe(instance.pluginId);
      scopes.push(scope);
      return function (this: unknown) {
        expect(this).toBe(source);
        if (revoked) {
          throw new Error("grant revoked");
        }
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
  authority.assertCurrent();
  revoked = true;
  expect(authority.assertCurrent).toThrow("grant revoked");
  expect(source.signal.aborted).toBe(false);
  expect(run).toHaveBeenCalledTimes(2);
  expect(new Set(run.mock.calls.map(([callback]) => callback)).size).toBe(1);
  expect(scopes).toHaveLength(2);
  expect(scopes[1]).not.toBe(scopes[0]);
  expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
  instance.quiesce();
  expect(authority.assertCurrent).toThrow("reloaded or disabled");
});

it.each(["retirement", "live-grant"])(
  "preserves native registered access-signal ownership through %s",
  async (scenario) => {
    await promisify(execFile)(
      process.execPath,
      [
        "--expose-gc",
        ...resolveRuntimeWorkerArgv(
          resolveRuntimeWorkerUrl(pluginRetentionEntrypoints.accessPolicy),
        ),
        scenario,
      ],
      { timeout: 20_000 },
    );
  },
  25_000,
);
