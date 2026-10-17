// @vitest-environment node
import { describe, expect, it, test } from "vitest";
import { contextBudgetStatusFixture } from "../../../../src/config/sessions/context-budget.test-support.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { resolveChatThinkingSelectState } from "../chat/thinking.ts";
import { reconcileSessionChanged, reconcileSessionHistory } from "./reconcile.ts";

const key = "agent:main:main";
const identity = {
  modelProvider: "test-provider",
  model: "reasoning-model",
  agentRuntime: { id: "openclaw", source: "model" as const },
};
const thinkingLevels = ["max", "ultra"].map((id) => ({ id, label: id }));
function sessionRow(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return { key, kind: "direct", updatedAt: 1, ...overrides };
}

function buildResult(sessions: SessionsListResult["sessions"]): SessionsListResult {
  return {
    ts: 1,
    path: "store",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

describe("history defaults ownership", () => {
  it.each(["unknown"] as const)(
    "replaces the selected %s owner without donating another owner's presentation",
    (sourceKey) => {
      const row = { key: sourceKey, kind: sourceKey, sessionId: "shared-session", updatedAt: 1 };
      const current = buildResult([
        {
          ...row,
          agentId: "main",
          derivedTitle: "Main title",
          lastMessagePreview: "Main preview",
        },
      ]);
      const incoming = { ...row, agentId: "work", updatedAt: 2 };
      expect(reconcileSessionHistory(current, incoming, undefined, { resultAgentId: "main" })).toBe(
        current,
      );
      const next = reconcileSessionHistory(current, incoming, undefined, {
        resultAgentId: "work",
      });
      expect(next?.sessions).toEqual([incoming]);
    },
  );

  it.each([
    { name: "keeps an empty roster's own inherited thinking", agentId: "main" },
    { name: "accepts the same agent's updated defaults", agentId: "work" },
  ])("$name", ({ agentId }) => {
    const defaults: SessionsListResult["defaults"] = {
      ...identity,
      contextTokens: 128_000,
      thinkingDefault: "low",
      thinkingLevels: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    };
    const current = { ...buildResult([]), defaults };
    const workDefaults = { ...defaults, thinkingDefault: "high" };
    const next = reconcileSessionHistory(
      current,
      {
        ...identity,
        key: "global",
        agentId: "work",
        kind: "global",
        sessionId: "work-session",
        updatedAt: 10,
      },
      workDefaults,
      { resultAgentId: agentId, selectedGlobalAgentId: "work" },
    );

    const ownAgent = agentId === "work";
    expect(
      resolveChatThinkingSelectState({ catalog: [], sessionKey: "global", sessionsResult: next })
        .inherited,
    ).toEqual({
      value: ownAgent ? "high" : "low",
      displayLabel: ownAgent ? "Inherited: High" : "Inherited: Low",
    });
    expect(next?.defaults).toEqual(ownAgent ? workDefaults : defaults);
    expect(next?.sessions.map((row) => row.sessionId)).toEqual(ownAgent ? ["work-session"] : []);
  });
});

test("enrichment survives omitted fields but not explicit transcript clearing receipts", () => {
  const initial = buildResult([
    sessionRow({
      sessionId: "same-session",
      derivedTitle: "Task",
      lastMessagePreview: "Last message",
      lastAssistantMessage: { text: "Assistant reply", timestamp: 1 },
    }),
  ]);
  const event = {
    sessionKey: key,
    agentId: "main",
    reason: "transcript",
    session: sessionRow({ sessionId: "same-session", updatedAt: 2 }),
  };
  const omitted = reconcileSessionChanged(initial, event).result;
  expect(omitted?.sessions[0]?.lastAssistantMessage).toEqual({
    text: "Assistant reply",
    timestamp: 1,
  });
  const cleared = reconcileSessionChanged(omitted, {
    ...event,
    session: {
      ...event.session,
      updatedAt: 3,
      derivedTitle: null,
      lastMessagePreview: null,
      lastAssistantMessage: null,
    },
  }).result;
  expect(cleared?.sessions[0]?.derivedTitle).toBeUndefined();
  expect(cleared?.sessions[0]?.lastMessagePreview).toBeUndefined();
  expect(cleared?.sessions[0]?.lastAssistantMessage).toBeUndefined();
});

test("reconciling the same sessions.changed twice keeps result identity on the second pass", () => {
  const result = buildResult([sessionRow()]);
  const payload = {
    sessionKey: key,
    reason: "patch",
    catalogChanged: true,
    ts: 2,
    updatedAt: 2,
    label: "Renamed",
  };

  const first = reconcileSessionChanged(result, payload);
  expect(first.applied).toBe(true);
  expect(first.result).not.toBe(result);
  expect(first.result?.sessions[0]?.label).toBe("Renamed");
  expect(first.result?.sessions[0]).not.toHaveProperty("catalogChanged");
  expect(first.result?.ts).toBe(2);

  // Duplicate capability/page delivery must not trigger another render.
  const second = reconcileSessionChanged(first.result ?? null, payload);
  expect(second.result).toBe(first.result);
});

test("sessions.changed deletes every nested null tombstone, not a hand-kept list", () => {
  // The gateway tombstones more fields than the old per-field cascade knew
  // about; these five leaked literal null into rows typed optional-not-null.
  const result = buildResult([
    {
      key,
      kind: "direct",
      updatedAt: 1,
      toolOverrides: { profile: "coding" },
      contextBudgetStatus: contextBudgetStatusFixture(),
      agentStatus: { state: "needs_attention", message: "Reply requested" },
      observerDigest: {
        agentId: "main",
        runId: "run-stale",
        headline: "Waiting",
        health: "needs_attention",
        updatedAt: 1,
        revision: 1,
      },
      controlOwnerSessionKey: "agent:main:owner",
      restartRecoveryStatus: "pending",
      goal: "ship it",
      modelOverrideSource: "user",
    } as never,
  ]);

  const reconciled = reconcileSessionChanged(result, {
    sessionKey: key,
    reason: "patch",
    session: {
      key,
      kind: "direct",
      updatedAt: 2,
      toolOverrides: null,
      contextBudgetStatus: null,
      agentStatus: null,
      observerDigest: null,
      controlOwnerSessionKey: null,
      restartRecoveryStatus: null,
      goal: null,
      modelOverrideSource: null,
    },
  } as never);

  expect(reconciled.applied).toBe(true);
  const row = reconciled.result?.sessions[0] as Record<string, unknown> | undefined;
  for (const field of [
    "toolOverrides",
    "contextBudgetStatus",
    "agentStatus",
    "observerDigest",
    "controlOwnerSessionKey",
    "restartRecoveryStatus",
    "goal",
  ]) {
    expect(row?.[field], field).toBeUndefined();
  }
  // updatedAt stays legitimately nullable and must not be deleted by the loop.
  expect(row?.updatedAt).toBe(2);
  // Clearing a pin means the gateway confirmed inheritance. Deleting that null would
  // make the row indistinguishable from a gateway too old to report provenance, and
  // the picker would keep showing the cleared pin.
  expect(row?.modelOverrideSource).toBeNull();
});

test("sessions.changed preserves the owner facet when ownership is unchanged", () => {
  const createdActor = { type: "human" as const, id: "profile-ada", label: "Ada" };
  const result = buildResult([
    sessionRow({ kind: "global", createdActor, owner: { actor: createdActor } }),
  ]);
  result.owners = [createdActor];

  const reconciled = reconcileSessionChanged(result, {
    sessionKey: key,
    reason: "send",
    updatedAt: 2,
    createdActor,
    owner: { actor: createdActor },
  });

  expect(reconciled.result?.owners).toEqual([createdActor]);
});

test("ownerless raw-global events invalidate without contaminating the selected agent row", () => {
  const researchOwner = { type: "agent" as const, id: "research", label: "Research" };
  const result = buildResult([
    {
      key: "global",
      kind: "global",
      updatedAt: 1,
      owner: { actor: researchOwner },
      model: "research-model",
      status: "done",
      hasActiveRun: false,
      activeRunIds: [],
    },
  ]);
  const payload = {
    sessionKey: "global",
    reason: "updated",
    updatedAt: 2,
    owner: { actor: { type: "agent", id: "ops", label: "Ops" } },
    model: "ops-model",
    status: "running",
    hasActiveRun: true,
    activeRunIds: ["ops-run"],
    inputTokens: 42,
  };

  const invalidated = reconcileSessionChanged(result, payload, {
    resultAgentId: "research",
    selectedGlobalAgentId: "research",
  });

  expect(invalidated.applied).toBe(false);
  expect(invalidated.result).toBe(result);
  expect(invalidated.row).toBeUndefined();

  const mainResult = buildResult([{ key: "main", kind: "direct", updatedAt: 1, status: "done" }]);
  const invalidatedMain = reconcileSessionChanged(
    mainResult,
    { sessionKey: "main", reason: "delete", ts: 2 },
    { resultAgentId: "main", selectedGlobalAgentId: "main" },
  );
  expect(invalidatedMain.applied).toBe(false);
  expect(invalidatedMain.result).toBe(mainResult);

  const ownerlessMain = reconcileSessionChanged(
    mainResult,
    {
      sessionKey: "main",
      activeRunIds: ["main-run"],
      hasActiveRun: true,
      status: "running",
      updatedAt: 2,
    },
    { resultAgentId: "main", selectedGlobalAgentId: "main" },
  );
  expect(ownerlessMain.applied).toBe(true);
  expect(ownerlessMain.row).toMatchObject({
    key: "main",
    activeRunIds: ["main-run"],
    hasActiveRun: true,
    status: "running",
  });
  expect(ownerlessMain.row).not.toHaveProperty("agentId");

  const explicit = reconcileSessionChanged(
    result,
    { ...payload, agentId: "research" },
    {
      resultAgentId: "research",
      selectedGlobalAgentId: "research",
    },
  );
  expect(explicit.applied).toBe(true);
  expect(explicit.row).toMatchObject({
    owner: { actor: { id: "ops" } },
    model: "ops-model",
    status: "running",
    activeRunIds: ["ops-run"],
  });
});

describe("reconcileSessionChanged", () => {
  it.each([
    {
      name: "configured Off",
      thinkingDefault: "off",
      thinkingLevel: undefined,
      levels: ["off", "medium"],
    },
    {
      name: "explicit Off",
      thinkingDefault: "medium",
      thinkingLevel: "off",
      levels: ["off", "medium"],
    },
    { name: "an empty profile", thinkingDefault: undefined, thinkingLevel: undefined, levels: [] },
  ])(
    "preserves $name when history omits prepared thinking metadata",
    ({ thinkingDefault, thinkingLevel, levels }) => {
      const row = {
        ...identity,
        key: "agent:main:main",
        kind: "direct" as const,
        sessionId: "s1",
        updatedAt: 1,
        thinkingLevel,
      };
      const metadata = {
        ...(thinkingDefault === undefined ? {} : { thinkingDefault }),
        thinkingLevels: levels.map((id) => ({ id, label: id })),
        thinkingOptions: levels,
      };
      const current = {
        ...buildResult([{ ...row, ...metadata }]),
        defaults: { ...identity, ...metadata, contextTokens: null },
      };
      const next = reconcileSessionHistory(
        current,
        { ...row, updatedAt: 2 },
        { ...identity, contextTokens: null },
      );

      const thinking = resolveChatThinkingSelectState({
        catalog: [],
        sessionKey: row.key,
        sessionsResult: next,
      });
      expect(thinking.options.map((option) => option.value)).toEqual(levels);
      expect(next?.sessions[0]).toMatchObject(metadata);
      expect(next?.defaults).toMatchObject(metadata);
      expect(next?.sessions[0]?.thinkingDefault).toBe(thinkingDefault);
      expect(next?.defaults.thinkingDefault).toBe(thinkingDefault);
      expect(next?.sessions[0]?.thinkingLevel).toBe(thinkingLevel);
      expect(thinking.selection).toMatchObject({
        source: thinkingLevel === undefined ? "default" : "override",
        value: thinkingLevel ?? thinkingDefault ?? "",
      });
    },
  );

  it("does not let stale chat history overwrite a newer runtime switch", () => {
    const current = buildResult([
      sessionRow({
        kind: "global",
        updatedAt: 3,
        sessionId: "s1",
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime: { id: "codex", source: "session-key" },
        thinkingLevels: [{ id: "max", label: "max" }],
      }),
    ]);

    const next = reconcileSessionHistory(
      current,
      {
        ...current.sessions[0]!,
        updatedAt: 2,
        agentRuntime: { id: "openclaw", source: "session-key" },
        thinkingLevels,
      },
      undefined,
    );

    expect(next).toBe(current);
  });

  it("preserves catalog-backed options when an event omits picker metadata", () => {
    const result = buildResult([
      sessionRow({
        kind: "global",
        updatedAt: 1,
        sessionId: "s1",
        modelProvider: "openai",
        model: "gpt-5.6-sol",
        agentRuntime: { id: "codex", source: "model" },
        thinkingLevels,
        thinkingOptions: ["max", "ultra"],
      }),
    ]);
    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "global",
      updatedAt: 2,
      sessionId: "s1",
      thinkingLevel: "ultra",
      agentRuntime: { id: "codex", source: "model" },
    });

    expect(next.row?.thinkingLevel).toBe("ultra");
    expect(next.row?.thinkingLevels).toEqual(thinkingLevels);
    expect(next.row?.thinkingOptions).toEqual(["max", "ultra"]);
  });

  it("clears a thinking override when the event carries null", () => {
    const result = buildResult([
      sessionRow({
        kind: "global",
        updatedAt: 1,
        sessionId: "s1",
        thinkingLevel: "ultra",
      }),
    ]);
    const next = reconcileSessionChanged(result, {
      sessionKey: key,
      key,
      kind: "global",
      updatedAt: 2,
      sessionId: "s1",
      thinkingLevel: null,
    });

    expect(next.row?.thinkingLevel).toBeUndefined();
  });
});
