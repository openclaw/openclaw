/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

const chip = (kind: SidebarAttentionKind, signature: string) => ({ kind, signature });
const storedDismissals = () => JSON.parse(localStorage.getItem(ATTENTION_KEY) ?? "null");

it("rearms changed affected sets", () => {
  localStorage.setItem(
    ATTENTION_KEY,
    JSON.stringify({ cronFailed: ["alpha"], modelAuthExpired: ["openai"] }),
  );
  expect(
    reconcileSidebarAttentionDismissals({
      key: ATTENTION_KEY,
      active: [chip("cronFailed", "beta"), chip("modelAuthExpired", "openai")],
    }),
  ).toEqual({ modelAuthExpired: ["openai"] });
});

it("preserves dismissals outside a partial agent inventory", () => {
  const stored = {
    cronFailed: ["main-job", "writer-job"],
    modelAuthExpired: ["agent:main\nopenai", "agent:writer\nopenai"],
  };
  localStorage.setItem(ATTENTION_KEY, JSON.stringify(stored));
  expect(
    reconcileSidebarAttentionDismissals({
      key: ATTENTION_KEY,
      active: [chip("cronFailed", "main-job"), chip("modelAuthExpired", "agent:main\nopenai")],
      scope: { cronInventoryComplete: false, modelAuthAgentId: "main" },
    }),
  ).toEqual(stored);
});

it.each([
  [{ phase: "pending", requestId: "request-1" }, null],
  [{ phase: "guidance" }, '["guidance","operator.read","operator.write"]'],
  [{ phase: "available" }, '["available","operator.read","operator.write"]'],
] as const)("binds dismissal to the actionable upgrade phase: %j", (state, signature) => {
  const entry = buildScopeUpgradeInboxEntry({
    scopes: ["operator.write", "operator.read"],
    state,
  });
  expect(entry).toMatchObject({ type: "scopeUpgrade" });
  expect(entry?.dismissal).toEqual(signature === null ? null : { kind: "scopeUpgrade", signature });
});
it("merges with the persisted map so another tab's dismissal survives", () => {
  localStorage.setItem(ATTENTION_KEY, JSON.stringify({ cronFailed: ["alpha"] }));
  const next = dismissSidebarAttention(ATTENTION_KEY, { kind: "cronFailed", signature: "beta" });
  const expected = { cronFailed: ["alpha", "beta"] };
  expect(next).toEqual(expected);
  expect(storedDismissals()).toEqual(expected);
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
it.each([
  {
    target: { kind: "package", version: "2026.8.3" },
    latestVersion: "2026.8.2",
    signature: '["2026.8.3","boot-a"]',
  },
  {
    target: {
      kind: "git",
      upstreamRef: "origin/main",
      upstreamSha: "abcdef1234567890",
      commitsBehind: 2,
    },
    latestVersion: "2026.8.1",
    signature: '["abcdef1234567890","boot-a"]',
  },
] as const)(
  "persists the $target.kind identity and literal boot binding",
  ({ target, latestVersion, signature }) => {
    const dismissal = resolveUpdateAttentionDismissal({
      gatewayBootId: "boot-a",
      updateAvailable: {
        currentVersion: "2026.8.1",
        latestVersion,
        channel: "stable",
      },
      updateSchedule: { channel: "stable", autoEnabled: false, target },
    });
    expect(dismissal).toEqual({ kind: "updateAvailable", signature });
    const stored = dismissSidebarAttention(ATTENTION_KEY, dismissal!);
    expect(isSidebarAttentionDismissed(stored, dismissal!)).toBe(true);
    expect(storedDismissals()).toEqual({ updateAvailable: [signature] });
  },
);
