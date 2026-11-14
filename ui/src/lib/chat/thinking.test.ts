import { expect, it } from "vitest";
import type { ModelCatalogEntry } from "../../api/types.ts";
import {
  formatThinkingCommandOptionsForSession,
  isThinkingLevelOptionForSession,
  resolveChatThinkingSelectState,
  resolveCurrentThinkingLevel,
  resolveThinkingCommandArgOptionsForSession,
  resolveThinkingLevelInput,
} from "./thinking.ts";

type SelectParams = Parameters<typeof resolveChatThinkingSelectState>[0];
const select = (params: Partial<SelectParams>) =>
  resolveChatThinkingSelectState({
    catalog: [],
    sessionKey: "agent:main:main",
    sessionsResult: null,
    ...params,
  });
const model = (overrides: Partial<ModelCatalogEntry> = {}): ModelCatalogEntry => ({
  provider: "metadata-fixture",
  id: "no-effort",
  name: "No selectable effort",
  reasoning: true,
  agentRuntime: { id: "openclaw", source: "model" },
  ...overrides,
});
const sessionFor = (entry: ModelCatalogEntry) => ({
  modelProvider: entry.provider,
  model: entry.id,
  agentRuntime: entry.agentRuntime,
});
const highProfile = { thinkingLevels: [{ id: "high", label: "High" }], thinkingDefault: "high" };
const roster = (
  session: SelectParams["session"],
  defaults: Partial<NonNullable<SelectParams["sessionsResult"]>["defaults"]> = {},
): NonNullable<SelectParams["sessionsResult"]> => ({
  ts: 1,
  path: "",
  count: 1,
  defaults: { modelProvider: null, model: null, contextTokens: null, ...defaults },
  sessions: [{ key: "agent:main:main", kind: "direct", updatedAt: 1, ...session }],
});

it("keeps an explicitly empty session profile and its saved override", () => {
  const state = select({
    sessionKey: "main",
    catalog: [
      {
        id: "model",
        provider: "openai",
        name: "Model",
        ...highProfile,
      },
    ],
    session: {
      model: "model",
      modelProvider: "openai",
      thinkingLevels: [],
      thinkingLevel: "off",
    },
  });
  expect(state).toMatchObject({
    options: [],
    inherited: { value: "" },
    selection: { source: "override", value: "off" },
  });
});

const emptySession = { modelProvider: "thinking-fixture", model: "no-effort", thinkingLevels: [] };
it.each([
  {
    name: "unknown",
    session: { modelProvider: "thinking-fixture", model: "unpublished" },
    defaults: undefined,
    label: "Unknown",
    high: undefined,
  },
  {
    name: "explicitly empty",
    session: emptySession,
    defaults: { ...emptySession, ...highProfile, contextTokens: null },
    label: "none",
    high: false,
  },
])(
  "keeps $name capability distinct from inherited choices",
  ({ session, defaults, label, high }) => {
    expect(select({ defaults, session })).toMatchObject({ options: [], inherited: { value: "" } });
    expect(resolveCurrentThinkingLevel(session, defaults, [])).toBe("Unknown");
    expect(formatThinkingCommandOptionsForSession(session, defaults, [])).toBe(label);
    expect(isThinkingLevelOptionForSession(session, defaults, "high")).toBe(high);
  },
);

it("keeps a ready empty thinking profile empty for the selected model", () => {
  const entry = model({ thinkingLevels: [] });
  const session = {
    ...sessionFor(entry),
    thinkingLevels: entry.thinkingLevels,
    thinkingOptions: [],
  };
  const state = select({ catalog: [entry], session });

  expect({
    options: state.options.map((option) => option.value),
    acceptsHigh: isThinkingLevelOptionForSession(session, undefined, "high", [entry]),
    inherited: state.inherited.value,
  }).toEqual({ options: [], acceptsHigh: false, inherited: "" });
  expect(formatThinkingCommandOptionsForSession(session, undefined, [entry])).toBe("none");
  expect(resolveThinkingCommandArgOptionsForSession(session, undefined, [entry])).toEqual([]);
});

it("preserves explicitly empty default labels metadata", () => {
  const entry = model();
  const session = sessionFor(entry);
  const defaults = { ...session, contextTokens: null, thinkingOptions: [] };
  expect(select({ catalog: [entry], defaults, session }).options).toEqual([]);
  expect(isThinkingLevelOptionForSession(session, defaults, "high", [entry])).toBe(false);
});

it("omits blank thinking choices and keeps the first normalized duplicate label in order", () => {
  const state = select({
    session: {
      thinkingLevels: [
        { id: "  ", label: "Blank" },
        { id: " HIGH ", label: "First high" },
        { id: "high", label: "Later high" },
        { id: "low", label: "Low" },
      ],
    },
  });

  expect(state.options).toEqual([
    { value: "high", label: "First high" },
    { value: "low", label: "Low" },
  ]);
});

it("keeps non-reasoning Off-only metadata distinct from an empty profile", () => {
  const entry = model({
    agentRuntime: undefined,
    reasoning: false,
    thinkingLevels: [{ id: "off", label: "off" }],
    thinkingDefault: "off",
  });
  const session = { modelProvider: entry.provider, model: entry.id, thinkingLevel: "off" };
  expect(select({ catalog: [entry], session })).toMatchObject({
    options: [],
    selection: { source: "default", value: "off" },
  });
  expect(isThinkingLevelOptionForSession(session, undefined, "off", [entry])).toBe(true);
  expect(isThinkingLevelOptionForSession(session, undefined, "high", [entry])).toBe(false);
});

it("normalizes canonical Ultra command input", () => {
  const session = { thinkingLevels: [{ id: "ultra", label: "Ultra" }] };
  expect(resolveThinkingLevelInput("ultra", session, undefined)).toBe("ultra");
});

it("does not promote an unsupported persisted Ultra override into a slider stop", () => {
  const state = select({
    sessionsResult: roster({
      thinkingLevel: "ultra",
      thinkingLevels: [{ id: "max", label: "max" }],
    }),
  });

  expect(state.selection).toEqual({
    kind: "unanchored",
    source: "override",
    value: "ultra",
    displayLabel: "Ultra",
  });
  expect(state.options.map((option) => option.value)).toEqual(["max"]);
});

it.each([true, false])(
  "inherits thinking metadata only without a runtime conflict (%s)",
  (conflict) => {
    const profile = {
      thinkingLevels: ["max", "ultra"].map((id) => ({ id, label: id })),
      thinkingDefault: "ultra",
    };
    const defaults = model(profile);
    const entry = { ...defaults, agentRuntime: conflict ? defaults.agentRuntime : undefined };
    const session = {
      ...sessionFor(entry),
      agentRuntime: { id: "codex", source: "session-key" as const },
    };
    const state = select({
      catalog: [entry],
      sessionsResult: roster(session, { ...sessionFor(defaults), ...profile }),
    });
    expect(state.options.map((option) => option.value)).toEqual(conflict ? [] : ["max", "ultra"]);
    expect(state.inherited.value).toBe(conflict ? "" : "ultra");
  },
);
