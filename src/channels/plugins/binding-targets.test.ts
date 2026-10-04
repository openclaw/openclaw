// Binding target tests cover channel binding target extraction and validation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureConfiguredBindingTargetReady,
  resetConfiguredBindingTargetInPlace,
} from "./binding-targets.js";
import type { ConfiguredBindingResolution } from "./binding-types.js";
const acp = vi.hoisted(() => ({
  ensureConfiguredAcpBindingTargetReady: vi.fn(),
  resolveAcpBindingTargetBySessionKey: vi.fn(),
  resetConfiguredAcpBindingTargetInPlace: vi.fn(),
}));
vi.mock("./acp-stateful-target-driver.js", () => acp);

function createBindingResolution(driverId: string): ConfiguredBindingResolution {
  return {
    conversation: {
      channel: "demo-binding",
      accountId: "default",
      conversationId: "123",
    },
    compiledBinding: {
      channel: "demo-binding",
      binding: {
        type: "acp" as const,
        agentId: "codex",
        match: {
          channel: "demo-binding",
          peer: {
            kind: "channel" as const,
            id: "123",
          },
        },
        acp: {
          mode: "persistent",
        },
      },
      bindingConversationId: "123",
      target: {
        conversationId: "123",
      },
      agentId: "codex",
      provider: {
        compileConfiguredBinding: () => ({
          conversationId: "123",
        }),
        matchInboundConversation: () => ({
          conversationId: "123",
        }),
      },
      targetFactory: {
        driverId,
        materialize: () => ({
          record: {
            bindingId: "binding:123",
            targetSessionKey: `agent:codex:${driverId}`,
            targetKind: "session",
            conversation: {
              channel: "demo-binding",
              accountId: "default",
              conversationId: "123",
            },
            status: "active",
            boundAt: 0,
          },
          statefulTarget: {
            kind: "stateful",
            driverId,
            sessionKey: `agent:codex:${driverId}`,
            agentId: "codex",
          },
        }),
      },
    },
    match: {
      conversationId: "123",
    },
    record: {
      bindingId: "binding:123",
      targetSessionKey: `agent:codex:${driverId}`,
      targetKind: "session",
      conversation: {
        channel: "demo-binding",
        accountId: "default",
        conversationId: "123",
      },
      status: "active",
      boundAt: 0,
    },
    statefulTarget: {
      kind: "stateful",
      driverId,
      sessionKey: `agent:codex:${driverId}`,
      agentId: "codex",
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("configured ACP binding targets", () => {
  it("delegates readiness to the ACP owner", async () => {
    const ensureReady = acp.ensureConfiguredAcpBindingTargetReady.mockResolvedValue({ ok: true });
    const bindingResolution = createBindingResolution("acp");
    await expect(
      ensureConfiguredBindingTargetReady({
        cfg: {} as never,
        bindingResolution,
      }),
    ).resolves.toEqual({ ok: true });
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(ensureReady).toHaveBeenCalledWith({
      cfg: {} as never,
      bindingResolution,
    });
  });

  it("resolves resets through the ACP session-key lookup", async () => {
    const resetInPlace = acp.resetConfiguredAcpBindingTargetInPlace.mockResolvedValue({ ok: true });
    acp.resolveAcpBindingTargetBySessionKey.mockResolvedValue({
      kind: "stateful",
      driverId: "acp",
      sessionKey: "agent:codex:acp",
      agentId: "codex",
    });

    await expect(
      resetConfiguredBindingTargetInPlace({
        cfg: {} as never,
        sessionKey: "agent:codex:acp",
        reason: "reset",
        commandSource: "discord:native",
      }),
    ).resolves.toEqual({ ok: true });

    expect(resetInPlace).toHaveBeenCalledTimes(1);
    expect(resetInPlace).toHaveBeenCalledWith({
      cfg: {} as never,
      sessionKey: "agent:codex:acp",
      reason: "reset",
      commandSource: "discord:native",
      bindingTarget: {
        kind: "stateful",
        driverId: "acp",
        sessionKey: "agent:codex:acp",
        agentId: "codex",
      },
    });
  });

  it("returns a typed error for an unsupported target driver", async () => {
    const bindingResolution = createBindingResolution("missing-driver");

    await expect(
      ensureConfiguredBindingTargetReady({
        cfg: {} as never,
        bindingResolution,
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Configured binding target driver unavailable: missing-driver",
    });
  });

  it("does not enter the ACP owner after readiness authority is revoked", async () => {
    await expect(
      ensureConfiguredBindingTargetReady({
        cfg: {},
        bindingResolution: createBindingResolution("acp"),
        assertActive: () => {
          throw new Error("admission retired");
        },
      }),
    ).resolves.toEqual({ ok: false, error: "admission retired" });
    expect(acp.ensureConfiguredAcpBindingTargetReady).not.toHaveBeenCalled();
  });

  it("skips reset when the ACP owner finds no target", async () => {
    acp.resolveAcpBindingTargetBySessionKey.mockResolvedValue(null);
    await expect(
      resetConfiguredBindingTargetInPlace({
        cfg: {},
        sessionKey: "agent:main:main",
        reason: "new",
      }),
    ).resolves.toEqual({ ok: false, skipped: true });
    expect(acp.resetConfiguredAcpBindingTargetInPlace).not.toHaveBeenCalled();
  });
});
