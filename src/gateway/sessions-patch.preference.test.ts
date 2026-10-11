import { afterEach, describe, expect, it, vi } from "vitest";
import { validateSessionsPatchParams } from "../../packages/gateway-protocol/src/index.js";
import { resolveModelFallbackOptions } from "../auto-reply/reply/agent-runner-run-params.js";
import { clearFollowupQueue, getFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { resolveResetPreservedSelection } from "../config/sessions/reset-preserved-selection.js";
import { mergeSessionSnapshotChanges } from "../config/sessions/session-snapshot-merge.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import {
  persistSessionPatchModelSelection,
  refreshSessionPatchQueuedSelection,
} from "./server-methods/sessions-patch-model-selection.js";
import {
  withAgentSessionModelPatchOrigin,
  withSessionStatusModelPatchOrigin,
} from "./session-model-patch-origin.js";
import { expectPatchError, expectPatchOk, runPatch } from "./sessions-patch.test-support.js";

const persistSticky = vi.hoisted(() => vi.fn());
vi.mock("../agents/sticky-model-selection.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agents/sticky-model-selection.js")>();
  return {
    ...actual,
    persistStickyModelSelectionBestEffort: persistSticky,
  };
});

const key = "agent:main:telegram:direct:fixture";
const siblingKey = "agent:second-bot:telegram:direct:fixture";
const cfg: OpenClawConfig = {
  plugins: { enabled: false },
  agents: {
    defaults: {
      model: { primary: "backup/fixture-default", fallbacks: ["backup/fixture-backup"] },
      modelSelectionScope: "global",
    },
  },
};
const model = "preferred/gpt-fixture";
const patch = { key, model, modelFallbackPolicy: "configured" as const };
const catalog = async () => [
  { provider: "preferred", id: "gpt-fixture", name: "preferred" },
  { provider: "backup", id: "fixture-default", name: "default" },
];

afterEach(() => {
  clearFollowupQueue(key);
  clearFollowupQueue(siblingKey);
  persistSticky.mockReset();
});

describe("session preference API integration", () => {
  it.each([
    { before: "configured" as const, after: null },
    { before: undefined, after: "configured" as const },
  ])(
    "marks a policy-only patch to $after for active selection refresh",
    async ({ before, after }) => {
      const original: SessionEntry = {
        sessionId: "policy-only",
        updatedAt: 1,
        providerOverride: "preferred",
        modelOverride: "gpt-fixture",
        modelOverrideSource: "user",
        modelFallbackPolicy: before,
        contextTokens: 16000,
      };
      const entry = expectPatchOk(
        await runPatch({
          cfg,
          store: { [key]: original },
          storeKey: key,
          patch: { key, modelFallbackPolicy: after },
          loadGatewayModelCatalog: catalog,
          providerAuthMetadataSnapshot: { plugins: [] },
        }),
      );
      expect(entry.modelFallbackPolicy).toBe(after ?? undefined);
      expect(entry.liveModelSwitchPending).toBe(true);
      expect(entry.contextTokens).toBe(16000);
    },
  );

  it("accepts only the explicit per-session opt-in or clear on the wire", () => {
    expect(validateSessionsPatchParams(patch)).toBe(true);
    expect(validateSessionsPatchParams({ key, modelFallbackPolicy: null })).toBe(true);
    expect(validateSessionsPatchParams({ key, modelFallbackPolicy: "anything" })).toBe(false);
  });
  it("persists only the target preference, not a global default or one-run rollback", async () => {
    const sibling: SessionEntry = { sessionId: "sibling", updatedAt: 1, thinkingLevel: "off" };
    const store = {
      [key]: { sessionId: "preferred", updatedAt: 1, thinkingLevel: "off" },
      [siblingKey]: sibling,
    };
    const configBefore = structuredClone(cfg);
    const entry = expectPatchOk(
      await withAgentSessionModelPatchOrigin(() =>
        runPatch({
          cfg,
          store,
          storeKey: key,
          patch,
          loadGatewayModelCatalog: catalog,
          providerAuthMetadataSnapshot: { plugins: [] },
        }),
      ),
    );
    expect(entry).toMatchObject({
      providerOverride: "preferred",
      modelOverride: "gpt-fixture",
      modelOverrideSource: "user",
      modelFallbackPolicy: "configured",
      thinkingLevel: "off",
    });
    expect(entry.modelFallback).toBeUndefined();
    persistSessionPatchModelSelection({
      cfg,
      entry,
      patch,
      sessionKey: key,
      targetAgentId: "main",
      callerScopes: ["operator.admin"],
    });
    expect(persistSticky).not.toHaveBeenCalled();
    expect(cfg).toEqual(configBefore);
    expect(store[siblingKey]).toBe(sibling);
    expect(resolveResetPreservedSelection({ entry }).modelFallbackPolicy).toBe("configured");

    const reset = expectPatchOk(
      await runPatch({
        cfg,
        store,
        storeKey: key,
        patch: { key, model: null },
        loadGatewayModelCatalog: catalog,
        providerAuthMetadataSnapshot: { plugins: [] },
      }),
    );
    expect(reset.modelOverride).toBeUndefined();
    expect(reset.modelFallbackPolicy).toBeUndefined();
    expect(reset.thinkingLevel).toBe("off");
    expect(cfg).toEqual(configBefore);
  });

  it("control: the same strict selection does reach the sticky default writer", async () => {
    const store = { [key]: { sessionId: "strict-control", updatedAt: 1 } };
    const strictPatch = { key, model };
    const entry = expectPatchOk(
      await runPatch({
        cfg,
        store,
        storeKey: key,
        patch: strictPatch,
        loadGatewayModelCatalog: catalog,
        providerAuthMetadataSnapshot: { plugins: [] },
      }),
    );
    expect(entry.modelFallbackPolicy).toBeUndefined();
    persistSessionPatchModelSelection({
      cfg,
      entry,
      patch: strictPatch,
      sessionKey: key,
      targetAgentId: "main",
      callerScopes: ["operator.admin"],
    });
    expect(persistSticky).toHaveBeenCalledTimes(1);
    expect(persistSticky).toHaveBeenCalledWith(
      expect.objectContaining({ model: "preferred/gpt-fixture", target: "defaults" }),
    );
  });

  it("a session_status selection stays strict and drops the preference", async () => {
    const original: SessionEntry = {
      sessionId: "status-origin",
      updatedAt: 1,
      providerOverride: "preferred",
      modelOverride: "gpt-fixture",
      modelOverrideSource: "user",
      modelFallbackPolicy: "configured",
      thinkingLevel: "off",
    };
    const { result } = await withSessionStatusModelPatchOrigin(() =>
      runPatch({
        cfg,
        store: { [key]: original },
        storeKey: key,
        patch: { key, model: "backup/fixture-backup" },
        loadGatewayModelCatalog: async () => [
          ...(await catalog()),
          { provider: "backup", id: "fixture-backup", name: "status" },
        ],
        providerAuthMetadataSnapshot: { plugins: [] },
      }),
    );
    const entry = expectPatchOk(result);
    expect(entry).toMatchObject({
      providerOverride: "backup",
      modelOverride: "fixture-backup",
      modelOverrideSource: "user",
      thinkingLevel: "off",
    });
    expect(entry.modelFallbackPolicy).toBeUndefined();
    expect(entry.modelFallback).toBeUndefined();
  });

  it("returning to default through agent-origin patch cannot restore the temporary preference", async () => {
    const original: SessionEntry = {
      sessionId: "back-to-default",
      updatedAt: 1,
      providerOverride: "preferred",
      modelOverride: "gpt-fixture",
      modelOverrideSource: "user",
      modelFallbackPolicy: "configured",
      thinkingLevel: "off",
    };
    const entry = expectPatchOk(
      await withAgentSessionModelPatchOrigin(() =>
        runPatch({
          cfg,
          store: { [key]: original },
          storeKey: key,
          patch: { key, model: null },
          loadGatewayModelCatalog: catalog,
          providerAuthMetadataSnapshot: { plugins: [] },
        }),
      ),
    );
    expect(entry.modelOverride).toBeUndefined();
    expect(entry.modelFallbackPolicy).toBeUndefined();
    expect(entry.modelFallback).toBeUndefined();
    expect(entry.thinkingLevel).toBe("off");
  });

  it("updates already queued runs and clears the preference when returning to default", async () => {
    const queue = getFollowupQueue(key, { mode: "followup" });
    queue.items.push({
      prompt: "queued",
      enqueuedAt: 1,
      run: {
        config: cfg,
        agentId: "main",
        sessionId: "queued",
        sessionKey: key,
        provider: "backup",
        model: "fixture-default",
        agentDir: "/fixture/agent",
        workspaceDir: "/fixture/workspace",
        sessionFile: "/fixture/session.jsonl",
        timeoutMs: 1000,
        blockReplyBreak: "message_end",
        thinkLevel: "off",
        thinkLevelOverride: "off",
      },
    });
    const entry: SessionEntry = {
      sessionId: "queued",
      updatedAt: 2,
      providerOverride: "preferred",
      modelOverride: "gpt-fixture",
      modelOverrideSource: "user",
      modelFallbackPolicy: "configured",
      thinkingLevel: "off",
    };
    refreshSessionPatchQueuedSelection({ cfg, entry, patch, sessionKey: key, agentId: "main" });
    const queued = queue.items[0]!.run;
    expect(queued).toMatchObject({
      model: "gpt-fixture",
      modelFallbackPolicy: "configured",
      thinkLevelOverride: "off",
    });
    expect(resolveModelFallbackOptions(queued).fallbacksOverride).toEqual([
      "backup/fixture-backup",
    ]);
    refreshSessionPatchQueuedSelection({
      cfg,
      entry: { sessionId: "queued", updatedAt: 3 },
      patch: { key, model: null },
      sessionKey: key,
      agentId: "main",
    });
    expect(queued.model).toBe("fixture-default");
    expect(queued.modelFallbackPolicy).toBeUndefined();
  });

  it("preserves a concurrent strict model change atomically against stale preference state", () => {
    const initial: SessionEntry = {
      sessionId: "race",
      updatedAt: 1,
      providerOverride: "preferred",
      modelOverride: "gpt-fixture",
      modelOverrideSource: "user",
    };
    const next: SessionEntry = { ...initial, modelFallbackPolicy: "configured" };
    const current: SessionEntry = { ...initial, updatedAt: 2, modelOverride: "another-strict" };
    const merged = mergeSessionSnapshotChanges({ initial, next, current });
    expect(merged.modelOverride).toBe("another-strict");
    expect(merged.modelFallbackPolicy).toBeUndefined();
  });

  it("new explicit strict selection removes the previous preference without changing thinking", () => {
    const entry: SessionEntry = {
      sessionId: "strict",
      updatedAt: 1,
      thinkingLevel: "off",
      providerOverride: "preferred",
      modelOverride: "gpt-fixture",
      modelFallbackPolicy: "configured",
    };
    applyModelOverrideToSessionEntry({
      entry,
      selection: { provider: "backup", model: "strict" },
    });
    expect(entry.modelFallbackPolicy).toBeUndefined();
    expect(entry.thinkingLevel).toBe("off");
  });

  it("rejects policy-only opt-in on a model-selection-locked session", async () => {
    const entry: SessionEntry = {
      sessionId: "locked",
      updatedAt: 1,
      modelSelectionLocked: true,
      providerOverride: "preferred",
      modelOverride: "gpt-fixture",
      modelOverrideSource: "user",
    };
    const store = { [key]: entry };
    expectPatchError(
      await runPatch({
        cfg,
        store,
        storeKey: key,
        patch: { key, modelFallbackPolicy: "configured" },
      }),
      "locked",
    );
    expect(store[key]).toBe(entry);
  });
});
