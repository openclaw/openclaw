import { beforeEach, expect, it, vi } from "vitest";
import type { readAcpSessionEntryAsync } from "../../acp/runtime/session-meta.js";

const mocks = vi.hoisted(() => ({
  performGatewaySessionReset: vi.fn(async () => ({
    ok: true as const,
    key: "agent:claude:acp:binding:discord:default:9373ab192b2317f4",
    entry: { sessionId: "next-session", lifecycleRevision: "next-lifecycle", updatedAt: 1 },
    storePath: "/tmp/claude-sessions.json",
  })),
  readAcpSessionEntryAsync: vi.fn<typeof readAcpSessionEntryAsync>(async () => null),
}));

// mock-isolation: Keep the ACP control plane's session-state dependencies outside this driver fixture.
vi.mock("../../acp/persistent-bindings.lifecycle.js", () => ({
  ensureConfiguredAcpBindingSession: vi.fn(),
}));
// mock-isolation: Reset results are fixtures; never reset real Gateway sessions.
vi.mock("../../gateway/session-reset-service.js", () => ({
  performGatewaySessionReset: mocks.performGatewaySessionReset,
}));
// mock-isolation: Read synthetic ACP metadata without opening session storage.
vi.mock("../../acp/runtime/session-meta.js", () => ({
  readAcpSessionEntryAsync: mocks.readAcpSessionEntryAsync,
}));
// mock-isolation: Do not discover configured bindings outside the driver fixture.
vi.mock("../../acp/persistent-bindings.resolve.js", () => ({
  resolveConfiguredAcpBindingSpecBySessionKey: vi.fn(() => null),
}));

import {
  resetConfiguredAcpBindingTargetInPlace,
  resolveAcpBindingTargetBySessionKey,
} from "./acp-stateful-target-driver.js";

const sessionKey = "agent:claude:acp:binding:discord:default:9373ab192b2317f4";
const bindingTarget = { kind: "stateful" as const, driverId: "acp", sessionKey, agentId: "claude" };

beforeEach(() => {
  mocks.performGatewaySessionReset.mockClear();
  mocks.readAcpSessionEntryAsync.mockReset().mockResolvedValue(null);
});

it("delegates bound resets to the gateway session reset authority", async () => {
  await expect(
    resetConfiguredAcpBindingTargetInPlace({
      cfg: {},
      sessionKey,
      reason: "new",
      commandSource: "discord:native",
      bindingTarget,
    }),
  ).resolves.toEqual({
    ok: true,
    sessionKey,
    sessionId: "next-session",
    lifecycleRevision: "next-lifecycle",
    storePath: "/tmp/claude-sessions.json",
  });

  expect(mocks.performGatewaySessionReset).toHaveBeenCalledWith({
    key: sessionKey,
    reason: "new",
    agentId: "claude",
    commandSource: "discord:native",
    armSessionDiffBaselineCapture: true,
    // Channel-native resets carry host-owned system authority.
    operatorRoleActor: { kind: "system" },
  });
});

it("keeps ACP reset available when metadata has already been cleared", async () => {
  expect(await resolveAcpBindingTargetBySessionKey({ cfg: {}, sessionKey })).toEqual(bindingTarget);
});
it("uses the canonical metadata owner for a bare binding whose harness differs", async () => {
  const cfg = { agents: { ownership: "explicit" as const, entries: { main: {}, work: {} } } };
  const target = { cfg, sessionKey: "global", agentId: "work" };
  mocks.readAcpSessionEntryAsync.mockResolvedValue({
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
  const resolved = await resolveAcpBindingTargetBySessionKey(target);
  expect(resolved).toMatchObject({ sessionKey: "global", agentId: "work" });
  expect(mocks.readAcpSessionEntryAsync).toHaveBeenLastCalledWith(target);
});
