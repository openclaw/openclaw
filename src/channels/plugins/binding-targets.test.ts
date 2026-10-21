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
// mock-isolation: Keep the real ACP backend and Gateway reset singletons outside this dispatch-only fixture.
vi.mock("./acp-stateful-target-driver.js", () => acp);

function createBindingResolution(driverId: string): ConfiguredBindingResolution {
  const conversation = { channel: "demo-binding", accountId: "default", conversationId: "123" };
  const target = { conversationId: "123" };
  const statefulTarget = {
    kind: "stateful" as const,
    driverId,
    sessionKey: `agent:codex:${driverId}`,
    agentId: "codex",
  };
  const record = {
    bindingId: "binding:123",
    targetSessionKey: statefulTarget.sessionKey,
    targetKind: "session" as const,
    conversation,
    status: "active" as const,
    boundAt: 0,
  };
  return {
    conversation,
    compiledBinding: {
      channel: "demo-binding",
      binding: {
        type: "acp" as const,
        agentId: "codex",
        match: { channel: "demo-binding", peer: { kind: "channel", id: "123" } },
        acp: { mode: "persistent" },
      },
      bindingConversationId: "123",
      target,
      agentId: "codex",
      provider: {
        compileConfiguredBinding: () => target,
        matchInboundConversation: () => target,
      },
      targetFactory: {
        driverId,
        materialize: () => ({ record, statefulTarget }),
      },
    },
    match: target,
    record,
    statefulTarget,
  };
}

beforeEach(() => vi.resetAllMocks());

describe("configured ACP binding targets", () => {
  it("delegates readiness to the ACP owner", async () => {
    const ensureReady = acp.ensureConfiguredAcpBindingTargetReady.mockResolvedValue({ ok: true });
    const bindingResolution = createBindingResolution("acp");
    const params = { cfg: {}, bindingResolution };
    await expect(ensureConfiguredBindingTargetReady(params)).resolves.toEqual({ ok: true });
    expect(ensureReady).toHaveBeenCalledTimes(1);
    expect(ensureReady).toHaveBeenCalledWith(params);
  });

  it("resolves resets through the ACP session-key lookup", async () => {
    const resetInPlace = acp.resetConfiguredAcpBindingTargetInPlace.mockResolvedValue({ ok: true });
    const bindingTarget = {
      kind: "stateful",
      driverId: "acp",
      sessionKey: "agent:codex:acp",
      agentId: "codex",
    };
    acp.resolveAcpBindingTargetBySessionKey.mockResolvedValue(bindingTarget);
    const params = {
      cfg: {},
      sessionKey: "agent:codex:acp",
      reason: "reset" as const,
      commandSource: "discord:native",
    };
    await expect(resetConfiguredBindingTargetInPlace(params)).resolves.toEqual({ ok: true });
    expect(resetInPlace).toHaveBeenCalledTimes(1);
    expect(resetInPlace).toHaveBeenCalledWith({ ...params, bindingTarget });
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
