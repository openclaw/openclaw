/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client as mockClient, createGatewayHarness } from "../app/overlays-access.test-support.ts";
import { createStorageMock as createTestStorageMock } from "../test-helpers/storage.ts";
import {
  clearSidebarAttentionDismissal,
  dismissSidebarAttention,
  isSidebarAttentionDismissed,
  loadDismissals,
  reconcileSidebarAttentionDismissals,
  resolveSidebarAttentionKey,
  resolveUpdateAttentionDismissal,
  type SidebarAttentionKind,
} from "./sidebar-attention-dismissals.ts";
import { buildScopeUpgradeInboxEntry } from "./sidebar-attention-entries.ts";

const ATTENTION_KEY = 'openclaw.control.sidebarAttention.v2:["ws://gateway.test","alice"]';

beforeEach(() => vi.stubGlobal("localStorage", createTestStorageMock()));
afterEach(() => vi.unstubAllGlobals());

describe("reconcileSidebarAttentionDismissals", () => {
  const chip = (kind: SidebarAttentionKind, signature: string) => ({
    kind,
    signature,
  });

  const reconcile = (
    dismissals: Record<string, string[]>,
    active: Array<{ kind: SidebarAttentionKind; signature: string }>,
    scope?: { cronInventoryComplete: boolean; modelAuthAgentId: string | null },
  ) => {
    localStorage.setItem(ATTENTION_KEY, JSON.stringify(dismissals));
    return reconcileSidebarAttentionDismissals({
      active,
      key: ATTENTION_KEY,
      ...(scope ? { scope } : {}),
    });
  };

  it("drops a dismissal when the affected set changes so the chip resurfaces", () => {
    expect(
      reconcile({ cronFailed: ["alpha"], modelAuthExpired: ["openai"] }, [
        chip("cronFailed", "beta"),
        chip("modelAuthExpired", "openai"),
      ]),
    ).toEqual({ modelAuthExpired: ["openai"] });
  });

  it("preserves dismissals outside a selected agent's partial inventory", () => {
    const dismissals = {
      cronFailed: ["main-job", "writer-job"],
      modelAuthExpired: ["agent:main\nopenai", "agent:writer\nopenai"],
    };
    expect(
      reconcile(
        dismissals,
        [chip("cronFailed", "main-job"), chip("modelAuthExpired", "agent:main\nopenai")],
        { cronInventoryComplete: false, modelAuthAgentId: "main" },
      ),
    ).toEqual(dismissals);
  });
});

describe("scope upgrade dismissal fact", () => {
  it("keeps a pending upgrade visible without a dismiss control", () => {
    const entry = buildScopeUpgradeInboxEntry({
      scopes: ["operator.write", "operator.read"],
      state: { phase: "pending", requestId: "request-1" },
    });
    expect(entry).toMatchObject({ type: "scopeUpgrade", dismissal: null });
  });

  it("resurfaces when manual guidance becomes an actionable upgrade", () => {
    const scopes = ["operator.write", "operator.read"];
    const guidance = buildScopeUpgradeInboxEntry({ scopes, state: { phase: "guidance" } });
    const available = buildScopeUpgradeInboxEntry({ scopes, state: { phase: "available" } });

    expect(guidance?.dismissal).toEqual({
      kind: "scopeUpgrade",
      signature: '["guidance","operator.read","operator.write"]',
    });
    expect(available?.dismissal).toEqual({
      kind: "scopeUpgrade",
      signature: '["available","operator.read","operator.write"]',
    });
  });
});

describe("dismissSidebarAttention", () => {
  it("merges with the persisted map so another tab's dismissal survives", () => {
    const key = ATTENTION_KEY;
    // Another tab dismissed a cron chip after this tab last loaded.
    localStorage.setItem(key, JSON.stringify({ cronFailed: ["alpha"] }));

    const next = dismissSidebarAttention(ATTENTION_KEY, {
      kind: "cronFailed",
      signature: "beta",
    });

    const expected = { cronFailed: ["alpha", "beta"] };
    expect(next).toEqual(expected);
    expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual(expected);
  });

  it("leaves unknown-owner legacy dismissals untouched and unadopted", () => {
    const legacyKey = "openclaw.control.sidebarAttention.v1:ws://gateway.test";
    const legacy = JSON.stringify({ cronFailed: "legacy-signature" });
    localStorage.setItem(legacyKey, legacy);
    expect(loadDismissals(ATTENTION_KEY)).toEqual({});
    dismissSidebarAttention(ATTENTION_KEY, { kind: "cronFailed", signature: "new-incident" });
    clearSidebarAttentionDismissal(ATTENTION_KEY, "cronFailed");
    expect(localStorage.getItem(legacyKey)).toBe(legacy);
    expect(localStorage.length).toBe(1);
  });

  it("does not read or write snoozes without a current authenticated profile", () => {
    dismissSidebarAttention(ATTENTION_KEY, { kind: "cronFailed", signature: "incident" });
    const gateway = createGatewayHarness(mockClient(async () => ({})));
    for (const state of [
      { phase: "connected" as const, selfUser: null },
      { phase: "reconnecting" as const, selfUser: { id: "alice", name: "Alice" } },
    ]) {
      gateway.update(state);
      const key = resolveSidebarAttentionKey(gateway.gateway);
      expect(key).toBeNull();
      expect(loadDismissals(key)).toEqual({});
      expect(dismissSidebarAttention(key, { kind: "cronFailed", signature: "other" })).toEqual({});
      clearSidebarAttentionDismissal(key, "cronFailed");
      expect(loadDismissals(ATTENTION_KEY)).toEqual({ cronFailed: ["incident"] });
    }
  });
});

describe("update dismissal fact", () => {
  it("uses the canonical package target and persists the literal boot binding", () => {
    const dismissal = resolveUpdateAttentionDismissal({
      gatewayBootId: "boot-a",
      updateAvailable: {
        currentVersion: "2026.8.1",
        latestVersion: "2026.8.2",
        channel: "latest",
      },
      updateSchedule: {
        channel: "stable",
        autoEnabled: false,
        target: { kind: "package", version: "2026.8.3" },
      },
    });
    expect(dismissal).toEqual({
      kind: "updateAvailable",
      signature: '["2026.8.3","boot-a"]',
    });
    const stored = dismissSidebarAttention(ATTENTION_KEY, dismissal!);
    expect(isSidebarAttentionDismissed(stored, dismissal!)).toBe(true);
    expect(JSON.parse(localStorage.getItem(ATTENTION_KEY) ?? "null")).toEqual({
      updateAvailable: ['["2026.8.3","boot-a"]'],
    });
  });

  it("uses the git target SHA instead of an unchanged package version", () => {
    expect(
      resolveUpdateAttentionDismissal({
        gatewayBootId: "boot-a",
        updateAvailable: {
          currentVersion: "2026.8.1",
          latestVersion: "2026.8.1",
          channel: "dev",
        },
        updateSchedule: {
          channel: "dev",
          autoEnabled: true,
          target: {
            kind: "git",
            upstreamRef: "origin/main",
            upstreamSha: "abcdef1234567890",
            commitsBehind: 2,
          },
        },
      }),
    ).toEqual({
      kind: "updateAvailable",
      signature: '["abcdef1234567890","boot-a"]',
    });
  });
});
