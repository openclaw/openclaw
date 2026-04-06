import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycleMocks = vi.hoisted(() => ({
  resetAcpSessionInPlace: vi.fn(async () => ({ ok: true as const })),
}));
const sessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionEntry: vi.fn(() => null),
}));
const resolveMocks = vi.hoisted(() => ({
  resolveConfiguredAcpBindingSpecBySessionKey: vi.fn(() => null),
}));

vi.mock("../../acp/persistent-bindings.lifecycle.js", () => ({
  ensureConfiguredAcpBindingReady: vi.fn(),
  ensureConfiguredAcpBindingSession: vi.fn(),
  resetAcpSessionInPlace: lifecycleMocks.resetAcpSessionInPlace,
}));
vi.mock("../../acp/runtime/session-meta.js", () => ({
  readAcpSessionEntry: sessionMetaMocks.readAcpSessionEntry,
}));
vi.mock("../../acp/persistent-bindings.resolve.js", () => ({
  resolveConfiguredAcpBindingSpecBySessionKey:
    resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey,
}));

import { acpStatefulBindingTargetDriver } from "./acp-stateful-target-driver.js";

describe("acpStatefulBindingTargetDriver", () => {
  beforeEach(() => {
    lifecycleMocks.resetAcpSessionInPlace.mockClear();
    sessionMetaMocks.readAcpSessionEntry.mockClear();
    resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey.mockClear();
  });

  it("forces ACP metadata clearing for bound reset targets", async () => {
    await expect(
      acpStatefulBindingTargetDriver.resetInPlace?.({
        cfg: {} as never,
        sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
        reason: "new",
        bindingTarget: {
          kind: "stateful",
          driverId: "acp",
          sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
          agentId: "claude",
        },
      }),
    ).resolves.toEqual({ ok: true });

    expect(lifecycleMocks.resetAcpSessionInPlace).toHaveBeenCalledWith({
      cfg: {} as never,
      sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      reason: "new",
      clearMeta: true,
    });
  });

  it("keeps ACP reset available when metadata has already been cleared", () => {
    expect(
      acpStatefulBindingTargetDriver.resolveTargetBySessionKey?.({
        cfg: {} as never,
        sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      }),
    ).toEqual({
      kind: "stateful",
      driverId: "acp",
      sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      agentId: "claude",
    });
  });
});
