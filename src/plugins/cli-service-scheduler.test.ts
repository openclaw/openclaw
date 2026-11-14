import { AsyncLocalStorage } from "node:async_hooks";
import { Command } from "commander";
import { expect, it } from "vitest";
import {
  readOperatorToolGatewayAuthority,
  runWithOperatorToolGatewayAuthority,
} from "../gateway/operator-tool-gateway-authority.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { LegacyPluginSdkResourceHost } from "./legacy-sdk-resource-host.js";
import { pluginInstanceInvocation } from "./plugin-instance-invocation.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { createOwnershipRecord } from "./registry-ownership.test-support.js";
import { createTestPluginRegistry } from "./registry-runtime.test-helpers.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { resolvePluginServiceScheduler } from "./service-scheduler-binding.js";
import type { PluginServiceSchedulerV1 } from "./service-scheduler.types.js";

it("retains the registered CLI owner's scheduler and joins its work before retirement", async () => {
  const clock = createGatewaySchedulerClock();
  const root = createTestGatewayScheduler(clock.clock);
  const host = new LegacyPluginSdkResourceHost();
  host.bindScheduler(root);
  const builder = createTestPluginRegistry();
  const record = createOwnershipRecord("scheduled-cli", { source: "test", configSchema: true });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  const instance = getPluginInstance(record)!;
  const program = new Command();
  const registration = { program, parentPath: [], config: {}, logger: api.logger };
  const entered = createDeferredCore<unknown>();
  const finish = createDeferredCore();
  const events: string[] = [];
  let scheduler: PluginServiceSchedulerV1 | undefined;
  let lateResolver: (() => PluginServiceSchedulerV1) | undefined;
  api.registerCli(
    ({ program: cliProgram }) =>
      void cliProgram.command("scheduled").action(() => {
        scheduler = resolvePluginServiceScheduler();
        lateResolver = AsyncLocalStorage.bind(resolvePluginServiceScheduler);
        scheduler.schedule({
          id: "tick",
          delayMs: 1,
          everyMs: 1,
          run: async () => {
            try {
              entered.resolve({
                instance:
                  pluginInstanceInvocation.getStore()?.instance === instance &&
                  instance.hasActiveCall,
                operator: readOperatorToolGatewayAuthority(),
                requester: getPluginRuntimeGatewayRequestScope()?.client,
                scheduler: resolvePluginServiceScheduler() === scheduler,
              });
            } catch (error) {
              entered.reject(error);
            }
            await finish.promise;
            events.push("settled");
          },
        });
      }),
    { commands: ["scheduled"] },
  );
  try {
    await host.run(() => builder.registry.cliRegistrars[0]!.register(registration));
    expect(() => resolvePluginServiceScheduler()).toThrow("requires a bound");
    const operator = new AbortController();
    await runWithOperatorToolGatewayAuthority(
      { signal: operator.signal, scopes: ["operator.read"], operatorRoleActor: { kind: "system" } },
      () => program.parseAsync(["scheduled"], { from: "user" }),
    );
    operator.abort();
    expect(lateResolver).toThrow("active plugin invocation");
    const dispatch = clock.advanceBy(1);
    expect(await entered.promise).toEqual({
      instance: true,
      operator: undefined,
      requester: undefined,
      scheduler: true,
    });
    const retirement = host.close().then(() => events.push("retired"));
    await Promise.resolve();
    expect(events).toEqual([]);
    finish.resolve();
    await Promise.all([dispatch, retirement]);
    expect(events).toEqual(["settled", "retired"]);
    expect(() => resolvePluginServiceScheduler(scheduler)).toThrow("closed");
    await clock.advanceBy(10);
    expect(events).toEqual(["settled", "retired"]);
  } finally {
    finish.resolve();
    await root.stop();
    await host.close();
    await instance.dispose();
  }
});
