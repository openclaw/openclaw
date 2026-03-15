import { describe, expect, it, vi } from "vitest";
import {
  applyExtensionHostTypedHookPolicy,
  bridgeExtensionHostLegacyHooks,
  constrainExtensionHostPromptInjectionHook,
} from "./hook-compat.js";

describe("extension host hook compatibility", () => {
  it("bridges legacy hooks only when internal hook registration is enabled", () => {
    const registerHook = vi.fn();

    bridgeExtensionHostLegacyHooks({
      events: ["before_send", "after_send"],
      handler: (() => {}) as never,
      hookSystemEnabled: true,
      registerHook: registerHook as never,
    });

    expect(registerHook).toHaveBeenCalledTimes(2);
    expect(registerHook).toHaveBeenNthCalledWith(1, "before_send", expect.any(Function));
    expect(registerHook).toHaveBeenNthCalledWith(2, "after_send", expect.any(Function));
  });

  it("constrains prompt-mutation fields for before_agent_start hooks", async () => {
    const handler = vi.fn(async () => ({
      messages: [{ role: "system", content: "keep" }],
      systemPrompt: "drop",
      prependContext: "drop",
      appendSystemContext: "drop",
    }));

    const constrained = constrainExtensionHostPromptInjectionHook(handler as never);
    const result = await constrained({} as never, {} as never);

    expect(result).toEqual({
      messages: [{ role: "system", content: "keep" }],
    });
  });

  it("blocks before_prompt_build and constrains before_agent_start when prompt injection is disabled", () => {
    const blocked = applyExtensionHostTypedHookPolicy({
      hookName: "before_prompt_build",
      handler: (() => ({})) as never,
      policy: { allowPromptInjection: false },
      blockedMessage: "blocked",
      constrainedMessage: "constrained",
    });
    const constrained = applyExtensionHostTypedHookPolicy({
      hookName: "before_agent_start",
      handler: (() => ({})) as never,
      policy: { allowPromptInjection: false },
      blockedMessage: "blocked",
      constrainedMessage: "constrained",
    });

    expect(blocked).toEqual({
      ok: false,
      message: "blocked",
    });
    expect(constrained.ok).toBe(true);
    if (constrained.ok) {
      expect(constrained.warningMessage).toBe("constrained");
      expect(constrained.entryHandler).toBeTypeOf("function");
    }
  });
});
