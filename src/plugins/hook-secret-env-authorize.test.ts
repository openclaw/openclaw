// Verifies the secret_env_authorize hook through the real hook runner:
// most-restrictive intersection, fail-closed default, and no handlers.
import { describe, expect, it } from "vitest";
import { createHookRunner } from "./hooks.js";
import { addStaticTestHooks, addTestHook } from "./hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginHookSecretEnvAuthorizeContext } from "./types.js";

const ctx: PluginHookSecretEnvAuthorizeContext = { agentId: "agent-1" };

function registryWith(
  hooks: Array<{ pluginId: string; allowedNames: string[]; priority?: number }>,
) {
  const registry = createEmptyPluginRegistry();
  addStaticTestHooks(registry, {
    hookName: "secret_env_authorize",
    hooks: hooks.map((h) => ({
      pluginId: h.pluginId,
      result: { allowedNames: h.allowedNames },
      ...(h.priority !== undefined ? { priority: h.priority } : {}),
    })),
  });
  return registry;
}

describe("secret_env_authorize hook", () => {
  it("returns undefined when no handlers are registered", async () => {
    const runner = createHookRunner(createEmptyPluginRegistry());
    await expect(
      runner.runSecretEnvAuthorize(
        { toolName: "exec", host: "gateway", candidates: [{ name: "A", kind: "env" }] },
        ctx,
      ),
    ).resolves.toBeUndefined();
  });

  it("intersects handler results so the most restrictive set wins", async () => {
    const registry = registryWith([
      { pluginId: "wide", allowedNames: ["A", "B", "C"] },
      { pluginId: "narrow", allowedNames: ["A", "B"] },
      { pluginId: "narrower", allowedNames: ["B"] },
    ]);
    const runner = createHookRunner(registry);
    await expect(
      runner.runSecretEnvAuthorize({ toolName: "exec", host: "gateway", candidates: [] }, ctx),
    ).resolves.toEqual({ allowedNames: ["B"] });
  });

  it("a handler that authorizes nothing makes the intersection empty", async () => {
    const registry = registryWith([
      { pluginId: "a", allowedNames: ["A", "B"] },
      { pluginId: "b", allowedNames: [] },
    ]);
    const runner = createHookRunner(registry);
    await expect(
      runner.runSecretEnvAuthorize({ toolName: "exec", host: "gateway", candidates: [] }, ctx),
    ).resolves.toEqual({ allowedNames: [] });
  });

  it("a bare runner is fail-open and yields no decision; the seam converts that to a denial", async () => {
    const registry = createEmptyPluginRegistry();
    addStaticTestHooks(registry, {
      hookName: "secret_env_authorize",
      hooks: [
        {
          pluginId: "crasher",
          result: { allowedNames: ["A"] },
          handler: () => {
            throw new Error("policy failed");
          },
        },
      ],
    });
    // A bare runner (no catchErrors/policy) logs the handler error and yields
    // no decision. authorizeSecretEnvProjection treats "registered but no
    // decision" as a denial, so fail-open at this layer is still fail-closed
    // at the seam.
    const runner = createHookRunner(registry);
    await expect(
      runner.runSecretEnvAuthorize({ toolName: "exec", host: "gateway", candidates: [] }, ctx),
    ).resolves.toBeUndefined();
  });

  it("stays fail-closed with catchErrors + policy, so the caller sees a denial not a value", async () => {
    const registry = createEmptyPluginRegistry();
    addStaticTestHooks(registry, {
      hookName: "secret_env_authorize",
      hooks: [
        {
          pluginId: "crasher",
          result: { allowedNames: ["A"] },
          handler: () => {
            throw new Error("policy failed");
          },
        },
      ],
    });
    const runner = createHookRunner(registry, {
      catchErrors: true,
      failurePolicyByHook: { secret_env_authorize: "fail-closed" },
    });
    await expect(
      runner.runSecretEnvAuthorize({ toolName: "exec", host: "gateway", candidates: [] }, ctx),
    ).rejects.toThrow(/policy failed/);
  });

  /**
   * Per-handler decision validation. The generic modifying runner skips
   * undefined/null handler results, so an allowing handler plus a non-deciding
   * handler used to yield an allowing aggregate. Every registered
   * secret_env_authorize handler must decide; a non-decision denies.
   */
  function registryWithHandlers(
    handlers: Array<{
      pluginId: string;
      handler: () => unknown;
      priority?: number;
      timeoutMs?: number;
    }>,
  ) {
    const registry = createEmptyPluginRegistry();
    for (const entry of handlers) {
      addTestHook({
        registry,
        pluginId: entry.pluginId,
        hookName: "secret_env_authorize",
        handler: entry.handler as never,
        ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
        ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
      });
    }
    return registry;
  }

  it("allow + undefined: a non-deciding handler denies instead of merging an allow", async () => {
    const registry = registryWithHandlers([
      { pluginId: "allowing", handler: () => ({ allowedNames: ["A", "B"] }) },
      { pluginId: "silent", handler: () => undefined },
    ]);
    const runner = createHookRunner(registry);
    await expect(
      runner.runSecretEnvAuthorize({ toolName: "exec", host: "gateway", candidates: [] }, ctx),
    ).resolves.toBeUndefined();
  });

  it("allow + null: a null decision denies instead of merging an allow", async () => {
    const registry = registryWithHandlers([
      { pluginId: "allowing", handler: () => ({ allowedNames: ["A"] }) },
      { pluginId: "nullable", handler: () => null },
    ]);
    const runner = createHookRunner(registry);
    await expect(
      runner.runSecretEnvAuthorize({ toolName: "exec", host: "gateway", candidates: [] }, ctx),
    ).resolves.toBeUndefined();
  });

  it("allow + malformed decision denies instead of trusting a partial shape", async () => {
    const registry = registryWithHandlers([
      { pluginId: "allowing", handler: () => ({ allowedNames: ["A"] }) },
      { pluginId: "malformed", handler: () => ({ allowedNames: "A" }) },
      { pluginId: "wrong-element", handler: () => ({ allowedNames: [1] }) },
    ]);
    const runner = createHookRunner(registry);
    await expect(
      runner.runSecretEnvAuthorize({ toolName: "exec", host: "gateway", candidates: [] }, ctx),
    ).resolves.toBeUndefined();
  });

  it("allow + throw: a throwing handler denies instead of merging an allow", async () => {
    const registry = registryWithHandlers([
      { pluginId: "allowing", handler: () => ({ allowedNames: ["A", "B"] }) },
      {
        pluginId: "crasher",
        handler: () => {
          throw new Error("policy failed");
        },
      },
    ]);
    // Bare runner (fail-open error logging) still yields no decision, and the
    // seam converts that to a denial.
    const runner = createHookRunner(registry);
    await expect(
      runner.runSecretEnvAuthorize({ toolName: "exec", host: "gateway", candidates: [] }, ctx),
    ).resolves.toBeUndefined();
  });

  it("allow + timeout: a timed-out handler denies instead of merging an allow", async () => {
    const registry = registryWithHandlers([
      { pluginId: "allowing", handler: () => ({ allowedNames: ["A", "B"] }) },
      {
        pluginId: "stalled",
        timeoutMs: 5,
        handler: () => new Promise(() => {}),
      },
    ]);
    const runner = createHookRunner(registry);
    await expect(
      runner.runSecretEnvAuthorize({ toolName: "exec", host: "gateway", candidates: [] }, ctx),
    ).resolves.toBeUndefined();
  });

  it("all-decision intersection preserves narrowing-only across several handlers", async () => {
    const registry = registryWithHandlers([
      { pluginId: "wide", handler: () => ({ allowedNames: ["A", "B", "C"] }), priority: 3 },
      { pluginId: "narrow", handler: () => ({ allowedNames: ["A", "B"] }), priority: 2 },
      { pluginId: "narrower", handler: () => ({ allowedNames: ["B"] }), priority: 1 },
    ]);
    const runner = createHookRunner(registry);
    await expect(
      runner.runSecretEnvAuthorize({ toolName: "exec", host: "gateway", candidates: [] }, ctx),
    ).resolves.toEqual({ allowedNames: ["B"] });
  });

  it("an explicit empty decision is authoritative and short-circuits to empty", async () => {
    const registry = registryWithHandlers([
      { pluginId: "allowing", handler: () => ({ allowedNames: ["A", "B"] }) },
      { pluginId: "denier", handler: () => ({ allowedNames: [] }) },
    ]);
    const runner = createHookRunner(registry);
    await expect(
      runner.runSecretEnvAuthorize({ toolName: "exec", host: "gateway", candidates: [] }, ctx),
    ).resolves.toEqual({ allowedNames: [] });
  });
});
