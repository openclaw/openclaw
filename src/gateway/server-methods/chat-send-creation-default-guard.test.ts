import { describe, expect, it, vi } from "vitest";
import { createChatSendSessionInitialization } from "./chat-send-session-binding.js";

const opts = () => ({ requestedSessionId: undefined });

describe("chat creation confidentiality commit guard", () => {
  it("revalidates the creation policy at the original session commit", () => {
    const current = vi.fn();
    const bind = vi.fn();
    const policy = vi.fn();
    const initialization = createChatSendSessionInitialization({
      sessionKey: "agent:main:dashboard:private",
      agentId: "main",
      needsCreationBinding: true,
      authorization: { bindCreation: bind, assertCurrent: current } as never,
      assertCreationDefaultCurrent: policy,
      getSessionInitializationOptions: opts,
    })();
    const guard = initialization.bindSessionCreation?.({} as never);
    expect(bind).toHaveBeenCalledOnce();
    expect(guard).toBeDefined();
    guard?.();
    expect(current).toHaveBeenCalledOnce();
    expect(policy).toHaveBeenCalledOnce();
    policy.mockImplementationOnce(() => {
      throw new Error("policy changed");
    });
    expect(() => guard?.()).toThrow("policy changed");
  });
  it("does not attach a creation guard to an already existing session", () => {
    const initialization = createChatSendSessionInitialization({
      sessionKey: "agent:main:dashboard:existing",
      agentId: "main",
      needsCreationBinding: false,
      authorization: undefined,
      assertCreationDefaultCurrent: vi.fn(),
      getSessionInitializationOptions: opts,
    })();
    expect(initialization.bindSessionCreation).toBeUndefined();
  });
});
