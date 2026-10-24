// @vitest-environment node
import { expect, it, test } from "vitest";
import { contextBudgetStatusFixture } from "../../../../src/config/sessions/context-budget.test-support.js";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { resolveChatThinkingSelectState } from "../chat/thinking.ts";
import { reconcileSessionChanged, reconcileSessionHistory } from "./reconcile.ts";
import { sessionsResult } from "./session-capability.test-support.ts";

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

const buildResult = (...sessions: SessionsListResult["sessions"]) => sessionsResult(sessions);

it("replaces an unknown owner without donating another owner's presentation", () => {
  const row = sessionRow({ key: "unknown", kind: "unknown", sessionId: "shared-session" });
  const current = buildResult({
    ...row,
    agentId: "main",
    derivedTitle: "Main title",
    lastMessagePreview: "Main preview",
  });
  const incoming = { ...row, agentId: "work", updatedAt: 2 };
  expect(reconcileSessionHistory(current, incoming, undefined, { resultAgentId: "main" })).toBe(
    current,
  );
  const next = reconcileSessionHistory(current, incoming, undefined, {
    resultAgentId: "work",
  });
  expect(next?.sessions).toEqual([incoming]);
});

it.each([
  { name: "keeps an empty roster's own inherited thinking", agentId: "main" },
  { name: "accepts the same agent's updated defaults", agentId: "work" },
])("$name", ({ agentId }) => {
  const defaults: SessionsListResult["defaults"] = {
    ...identity,
    contextTokens: 128_000,
    thinkingDefault: "low",
    thinkingLevels: ["Low", "High"].map((label) => ({ id: label.toLowerCase(), label })),
  };
  const current = { ...buildResult(), defaults };
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

test("enrichment survives omitted fields but not explicit transcript clearing receipts", () => {
  const initial = buildResult(
    sessionRow({
      sessionId: "same-session",
      derivedTitle: "Task",
      lastMessagePreview: "Last message",
      lastAssistantMessage: { text: "Assistant reply", timestamp: 1 },
    }),
  );
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
  const result = buildResult(sessionRow());
  const payload = {
    sessionKey: key,
    reason: "patch",
    catalogChanged: true,
    ts: 2,
    updatedAt: 2,
    label: "Renamed",
  };

  const first = reconcileSessionChanged(result, payload);
  expect(first).toMatchObject({
    applied: true,
    result: { ts: 2, sessions: [{ label: "Renamed" }] },
  });
  expect(first.result).not.toBe(result);
  expect(first.result?.sessions[0]).not.toHaveProperty("catalogChanged");

  const second = reconcileSessionChanged(first.result ?? null, payload);
  expect(second.result).toBe(first.result);
});

test("sessions.changed deletes every nested null tombstone, not a hand-kept list", () => {
  const fields = {
    toolOverrides: { profile: "coding" },
    contextBudgetStatus: contextBudgetStatusFixture(),
    agentStatus: { state: "needs_attention" },
    observerDigest: { headline: "Waiting" },
    controlOwnerSessionKey: "agent:main:owner",
    restartRecoveryStatus: "pending",
    goal: "ship it",
  };
  const tombstones = Object.fromEntries(Object.keys(fields).map((field) => [field, null]));
  const result = buildResult(sessionRow({ ...fields, modelOverrideSource: "user" } as never));

  const reconciled = reconcileSessionChanged(result, {
    sessionKey: key,
    reason: "patch",
    session: sessionRow({ updatedAt: 2, ...tombstones, modelOverrideSource: null }),
  } as never);

  expect(reconciled.applied).toBe(true);
  const row = reconciled.result?.sessions[0] as Record<string, unknown> | undefined;
  for (const field of Object.keys(fields)) {
    expect(row?.[field], field).toBeUndefined();
  }
  // Unlike optional fields, null pin provenance confirms inheritance.
  expect(row).toMatchObject({ updatedAt: 2, modelOverrideSource: null });
});

test("sessions.changed preserves the owner facet when ownership is unchanged", () => {
  const createdActor = { type: "human" as const, id: "profile-ada", label: "Ada" };
  const result = buildResult(
    sessionRow({ kind: "global", createdActor, owner: { actor: createdActor } }),
  );
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

it.each(["raw global", "main delete", "main update", "explicit global"])(
  "keeps event ownership scoped for %s",
  (mode) => {
    const global = mode.includes("global");
    const agentId = global ? "research" : "main";
    const activity = {
      status: "running",
      hasActiveRun: true,
      activeRunIds: [global ? "ops-run" : "main-run"],
    };
    const result = buildResult(
      sessionRow({
        key: global ? "global" : "main",
        kind: global ? "global" : "direct",
        status: "done",
        ...(global
          ? {
              owner: { actor: { type: "agent", id: "research", label: "Research" } },
              model: "research-model",
            }
          : {}),
      }),
    );
    const payload =
      mode === "main delete"
        ? { sessionKey: "main", reason: "delete", ts: 2 }
        : {
            sessionKey: global ? "global" : "main",
            updatedAt: 2,
            ...activity,
            ...(global
              ? {
                  reason: "updated",
                  owner: { actor: { type: "agent", id: "ops", label: "Ops" } },
                  model: "ops-model",
                }
              : {}),
            ...(mode === "explicit global" ? { agentId } : {}),
          };
    const changed = reconcileSessionChanged(result, payload, {
      resultAgentId: agentId,
      selectedGlobalAgentId: agentId,
    });
    const applied = mode !== "raw global" && mode !== "main delete";
    expect(changed.applied).toBe(applied);
    if (!applied) {
      expect(changed.result).toBe(result);
      if (global) {
        expect(changed.row).toBeUndefined();
      }
    } else {
      expect(changed.row).toMatchObject(
        global
          ? {
              owner: { actor: { id: "ops" } },
              model: "ops-model",
              status: "running",
              activeRunIds: ["ops-run"],
            }
          : { key: "main", status: "running", hasActiveRun: true, activeRunIds: ["main-run"] },
      );
      if (!global) {
        expect(changed.row).not.toHaveProperty("agentId");
      }
    }
  },
);

it.each([
  ["configured Off", "off", undefined, ["off", "medium"]],
  ["explicit Off", "medium", "off", ["off", "medium"]],
  ["an empty profile", undefined, undefined, []],
] as const)(
  "preserves %s when history omits thinking metadata",
  (_name, thinkingDefault, thinkingLevel, levels) => {
    const row = sessionRow({
      ...identity,
      sessionId: "s1",
      thinkingLevel,
    });
    const metadata = {
      ...(thinkingDefault === undefined ? {} : { thinkingDefault }),
      thinkingLevels: levels.map((id) => ({ id, label: id })),
      thinkingOptions: [...levels],
    };
    const current = {
      ...buildResult({ ...row, ...metadata }),
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
  const current = buildResult(
    sessionRow({
      kind: "global",
      updatedAt: 3,
      sessionId: "s1",
      modelProvider: "openai",
      model: "gpt-5.6-luna",
      agentRuntime: { id: "codex", source: "session-key" },
      thinkingLevels: [{ id: "max", label: "max" }],
    }),
  );

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

it.each([false, true])("reconciles thinking metadata (clear override: %s)", (clear) => {
  const result = buildResult(
    sessionRow({
      kind: "global",
      sessionId: "s1",
      ...(clear
        ? { thinkingLevel: "ultra" }
        : {
            modelProvider: "openai",
            model: "gpt-5.6-sol",
            agentRuntime: { id: "codex", source: "model" as const },
            thinkingLevels,
            thinkingOptions: ["max", "ultra"],
          }),
    }),
  );
  const next = reconcileSessionChanged(result, {
    sessionKey: key,
    key,
    kind: "global",
    updatedAt: 2,
    sessionId: "s1",
    thinkingLevel: clear ? null : "ultra",
    ...(clear ? {} : { agentRuntime: { id: "codex", source: "model" } }),
  });
  expect(next.row?.thinkingLevel).toBe(clear ? undefined : "ultra");
  if (!clear) {
    expect(next.row?.thinkingLevels).toEqual(thinkingLevels);
    expect(next.row?.thinkingOptions).toEqual(["max", "ultra"]);
  }
});
