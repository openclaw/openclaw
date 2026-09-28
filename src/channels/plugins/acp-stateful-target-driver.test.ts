import { beforeEach, describe, expect, it, vi } from "vitest";
// ACP stateful target driver tests cover ACP target state persistence and routing.
import type { readAcpSessionEntryAsync } from "../../acp/runtime/session-meta.js";

const resetMocks = vi.hoisted(() => ({
  performGatewaySessionReset: vi.fn(async () => ({
    ok: true as const,
    key: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
    entry: { sessionId: "next-session", updatedAt: 1 },
    agentId: "claude",
    storePath: "/tmp/claude-sessions.json",
  })),
}));
const sessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionEntryAsync: vi.fn<typeof readAcpSessionEntryAsync>(async () => null),
}));
const resolveMocks = vi.hoisted(() => ({
  resolveConfiguredAcpBindingSpecBySessionKey: vi.fn(() => null),
}));

vi.mock("../../acp/persistent-bindings.lifecycle.js", () => ({
  ensureConfiguredAcpBindingReadyCore: vi.fn(),
  ensureConfiguredAcpBindingSession: vi.fn(),
}));
vi.mock("../../gateway/session-reset-service.js", () => ({
  performGatewaySessionReset: resetMocks.performGatewaySessionReset,
}));
vi.mock("../../acp/runtime/session-meta.js", () => ({
  readAcpSessionEntryAsync: sessionMetaMocks.readAcpSessionEntryAsync,
}));
vi.mock("../../acp/persistent-bindings.resolve.js", () => ({
  resolveConfiguredAcpBindingSpecBySessionKey:
    resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey,
}));

import { acpStatefulBindingTargetDriver } from "./acp-stateful-target-driver.js";

describe("acpStatefulBindingTargetDriver", () => {
  beforeEach(() => {
    resetMocks.performGatewaySessionReset.mockClear();
    sessionMetaMocks.readAcpSessionEntryAsync.mockReset().mockResolvedValue(null);
    resolveMocks.resolveConfiguredAcpBindingSpecBySessionKey.mockClear();
  });

  it("delegates bound resets to the gateway session reset authority", async () => {
    await expect(
      acpStatefulBindingTargetDriver.resetInPlace?.({
        cfg: {},
        sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
        reason: "new",
        commandSource: "discord:native",
        bindingTarget: {
          kind: "stateful",
          driverId: "acp",
          sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
          agentId: "claude",
        },
      }),
    ).resolves.toEqual({
      ok: true,
      sessionKey: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      sessionId: "next-session",
      storePath: "/tmp/claude-sessions.json",
    });

    expect(resetMocks.performGatewaySessionReset).toHaveBeenCalledWith({
      key: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
      reason: "new",
      agentId: "claude",
      commandSource: "discord:native",
      armSessionDiffBaselineCapture: true,
      // Channel-native resets are host-owned dispatch and carry system authority
      // so operator role boundaries never silently block them.
      operatorRoleActor: { kind: "system" },
    });
  });

  it("keeps ACP reset available when metadata has already been cleared", async () => {
    expect(
      await acpStatefulBindingTargetDriver.resolveTargetBySessionKey?.({
        cfg: {},
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

it("uses the canonical metadata owner for a bare binding whose harness differs", async () => {
  const cfg = { agents: { ownership: "explicit" as const, entries: { main: {}, work: {} } } };
  const target = { cfg, sessionKey: "global", agentId: "work" };
  sessionMetaMocks.readAcpSessionEntryAsync.mockResolvedValue({
    ...target,
    storeSessionKey: "global",
    storePath: "/tmp/synthetic-owner/sessions.json",
    acp: {
      backend: "acpx",
      agent: "fixture-harness",
      runtimeSessionName: "synthetic-locator",
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
    },
  });
  const bindingTarget = await acpStatefulBindingTargetDriver.resolveTargetBySessionKey?.(target);
  expect(bindingTarget).toMatchObject({ sessionKey: "global", agentId: "work" });
  expect(sessionMetaMocks.readAcpSessionEntryAsync).toHaveBeenLastCalledWith(target);
});
