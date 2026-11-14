import { afterEach, describe, expect, it, vi } from "vitest";
import { createHookRunner } from "./hooks.js";
import type { HookRunner } from "./hooks.js";
import { addTestHook } from "./hooks.test-helpers.js";
import { captureCurrentPluginInstanceAuthority } from "./plugin-instance-scope.js";
import { createOwnedTestInstance } from "./plugin-instance.test-support.js";
import { PluginInvocationScope } from "./plugin-invocation-scope.js";

const context = {
  runId: "completed-child",
  childSessionKey: "agent:test:subagent:child",
  requesterSessionKey: "agent:test:main",
};
const origin = { channel: "discord", accountId: "work", to: "channel:777", threadId: "777" };
const dispatches = [
  {
    hookName: "subagent_ended",
    run: (runner: HookRunner) =>
      runner.runSubagentEnded(
        {
          targetSessionKey: context.childSessionKey,
          targetKind: "subagent",
          reason: "subagent-complete",
        },
        context,
      ),
  },
  {
    hookName: "subagent_delivery_target",
    run: (runner: HookRunner) =>
      runner.runSubagentDeliveryTarget(
        {
          ...context,
          expectsCompletionMessage: true,
          requesterOrigin: { channel: "discord", accountId: "work", to: "channel:123" },
        },
        context,
      ),
  },
] as const;

afterEach(() => vi.restoreAllMocks());

describe.each(dispatches)("post-turn $hookName", ({ hookName, run }) => {
  function fixture() {
    const instance = createOwnedTestInstance("post-turn");
    const registry = instance.owner!.registry!;
    let authority: ReturnType<typeof captureCurrentPluginInstanceAuthority>;
    const handler = vi.fn(async () => {
      authority = captureCurrentPluginInstanceAuthority();
      authority!.assertCurrent();
      await Promise.resolve();
      authority!.assertCurrent();
      return { origin };
    });
    addTestHook({
      registry,
      pluginId: instance.pluginId,
      hookName,
      handler: instance.wrap(handler),
    });
    return {
      instance,
      registry,
      handler,
      runner: createHookRunner(registry, { catchErrors: false }),
      caller: new PluginInvocationScope(registry, [instance], { retained: true }),
      assertSettled: () => expect(() => authority!.assertCurrent()).toThrow(/reloaded or disabled/),
    };
  }

  it("admits the registered handler after the originating turn scope closes", async () => {
    const f = fixture();
    await f.caller.run(async () => {
      f.caller.release();
      const result = await run(f.runner);
      expect(f.handler).toHaveBeenCalledOnce();
      if (hookName === "subagent_delivery_target") {
        expect(result).toEqual({ origin });
      }
      f.assertSettled();
    });
    expect(f.instance.ordinaryCallCount).toBe(0);
  });

  it.each(["replaced", "removed"])(
    "rejects a %s plugin even after the turn closes",
    async (state) => {
      const f = fixture();
      await f.caller.run(async () => {
        f.caller.release();
        if (state === "removed") {
          await f.instance.dispose();
        } else {
          f.instance.quiesce();
        }
        await expect(run(f.runner)).rejects.toThrow(/reloaded or disabled/);
        expect(f.handler).not.toHaveBeenCalled();
      });
    },
  );

  it("does not revive a closure explicitly bound to the finished turn", async () => {
    const f = fixture();
    const hook = f.registry.typedHooks[0]!;
    hook.handler = f.caller.wrap(hook.handler);
    f.caller.release();
    await expect(run(f.runner)).rejects.toThrow("Plugin post-turn consumer is closed");
    expect(f.handler).not.toHaveBeenCalled();
  });
});
