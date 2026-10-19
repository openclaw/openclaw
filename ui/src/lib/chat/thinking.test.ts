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
  defaults: NonNullable<SelectParams["sessionsResult"]>["defaults"] = {
    modelProvider: null,
    model: null,
    contextTokens: null,
  },
): NonNullable<SelectParams["sessionsResult"]> => ({
  ts: 1,
  path: "",
  count: 1,
  defaults,
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
  const state = select({ catalog: [entry], defaults, session });

  expect(state.options).toEqual([]);
  expect(isThinkingLevelOptionForSession(session, defaults, "high", [entry])).toBe(false);
});

it("keeps non-reasoning Off-only metadata distinct from an empty profile", () => {
  const entry = model({
    id: "plain",
    name: "Plain model",
    agentRuntime: undefined,
    reasoning: false,
    thinkingLevels: [{ id: "off", label: "off" }],
    thinkingDefault: "off",
  });
  const session = { modelProvider: entry.provider, model: entry.id, thinkingLevel: "off" };
  const state = select({ catalog: [entry], session });

  expect(state).toMatchObject({ options: [], selection: { source: "default", value: "off" } });
  expect(isThinkingLevelOptionForSession(session, undefined, "off", [entry])).toBe(true);
  expect(isThinkingLevelOptionForSession(session, undefined, "high", [entry])).toBe(false);
});

const lunaModel = model({
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  provider: "openai",
  thinkingLevels: [
    { id: "max", label: "max" },
    { id: "ultra", label: "ultra" },
  ],
  thinkingDefault: "ultra",
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

it("does not inherit same-model thinking metadata from a different runtime", () => {
  const state = select({
    catalog: [lunaModel],
    sessionsResult: roster(
      {
        modelProvider: "openai",
        model: "gpt-5.6-luna",
        agentRuntime: { id: "codex", source: "session-key" },
      },
      {
        ...sessionFor(lunaModel),
        contextTokens: null,
        thinkingLevels: lunaModel.thinkingLevels,
        thinkingDefault: lunaModel.thinkingDefault,
      },
    ),
  });

  expect(state.options.map((option) => option.value)).not.toContain("ultra");
  expect(state.inherited.value).not.toBe("ultra");
});

it("inherits catalog thinking metadata when runtimes do not conflict", () => {
  const state = select({
    catalog: [{ ...lunaModel, agentRuntime: undefined }],
    session: {
      ...sessionFor(lunaModel),
      agentRuntime: { id: "codex", source: "session-key" },
    },
  });

  expect(state.options.map((option) => option.value)).toEqual(["max", "ultra"]);
  expect(state.inherited.value).toBe("ultra");
});
