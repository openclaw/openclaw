import { expect, it } from "vitest";
import { extractQueryTerms, filterSessionsByQuery } from "./usage-query.js";

type QuerySession = Parameters<typeof filterSessionsByQuery>[0][number];
const makeSession = (
  key: string,
  usage: QuerySession["usage"],
  fields: Omit<QuerySession, "key" | "usage"> = {},
) => ({ key, usage, ...fields });

it("tokenizes query terms including quoted strings", () => {
  const terms = extractQueryTerms(
    'agent:main "model:gpt-5.2" label:"Team Planning" "label:Team  Planning" "free phrase" has:errors',
  );
  expect(terms).toEqual([
    { key: "agent", value: "main", raw: "agent:main" },
    { key: "model", value: "gpt-5.2", raw: '"model:gpt-5.2"' },
    { key: "label", value: "Team Planning", raw: 'label:"Team Planning"' },
    { key: "label", value: "Team  Planning", raw: '"label:Team  Planning"' },
    { value: "free phrase", raw: '"free phrase"' },
    { key: "has", value: "errors", raw: "has:errors" },
  ]);
});

it("matches quoted multi-word session labels", () => {
  const session = { key: "planning", label: "Team Planning", usage: null };

  expect(filterSessionsByQuery([session], 'label:"Team Planning"').sessions).toEqual([session]);
  expect(filterSessionsByQuery([session], '"Team Planning"').sessions).toEqual([session]);
});

function populatedSessions() {
  const rows: [string, string, string, number, number, string][] = [
    ["openai", "discord", "gpt", 100, 1, "read"],
    ["anthropic", "slack", "claude", 80, 0, "write"],
    ["google", "discord", "gemini", 60, 1, "read"],
  ];
  return rows.map(([key, channel, model, totalTokens, errors, name]) =>
    makeSession(
      key,
      {
        totalTokens,
        messageCounts: { errors },
        toolUsage: { totalCalls: 1, tools: [{ name }] },
      },
      { channel, modelProvider: key, model, hasContextWeight: true },
    ),
  );
}
it("unions categorical values while intersecting categories and other constraints", () => {
  const sessions = populatedSessions();
  const cases: Array<[query: string, keys: string[]]> = [
    ["provider:openai provider:anthropic", ["openai", "anthropic"]],
    ["provider: provider:openai", ["openai"]],
    ["channel:discord channel:slack", ["openai", "anthropic", "google"]],
    ["model:gpt model:claude", ["openai", "anthropic"]],
    ["tool:read tool:write", ["openai", "anthropic", "google"]],
    ["provider:openai provider:anthropic channel:discord", ["openai"]],
    ["provider:openai provider:anthropic minTokens:90 has:errors has:tools", ["openai"]],
    ["minTokens:50 minTokens:90", ["openai"]],
    ["has:errors has:tools", ["openai", "google"]],
  ];

  for (const [query, keys] of cases) {
    expect(filterSessionsByQuery(sessions, query).sessions.map((session) => session.key)).toEqual(
      keys,
    );
  }
});

it("supports numeric filters like minTokens/maxTokens", () => {
  const a = makeSession("a", { totalTokens: 1_000, totalCost: 20, messageCounts: { total: 30 } });
  const b = makeSession("b", { totalTokens: 5, totalCost: 2, messageCounts: { total: 3 } });
  const filters = [
    "minTokens:10",
    "minTokens:1k",
    "minCost:10",
    "minMessages:10",
    "maxTokens:10",
    "maxCost:10",
    "maxMessages:10",
  ];

  for (const [index, filter] of filters.entries()) {
    expect(filterSessionsByQuery([a, b], filter)).toEqual({
      sessions: [index < 4 ? a : b],
      warnings: [],
    });
  }
});

it("does not classify unknown usage as zero or as its known subtotal", () => {
  const interrupted = makeSession("interrupted", {
    usageReport: { state: "unavailable" },
    totalTokens: 100,
    totalCost: 0,
    messageCounts: { total: 2 },
  });
  for (const query of ["minTokens:10", "maxTokens:1000", "minCost:0", "maxCost:1"]) {
    expect(filterSessionsByQuery([interrupted], query).sessions).toEqual([]);
  }
  expect(filterSessionsByQuery([interrupted], "minMessages:1").sessions).toEqual([interrupted]);
});

it("supports every has predicate and warns on unknown values", () => {
  const populated = populatedSessions()[0]!;
  const empty = makeSession("empty", null);

  for (const value of ["tools", "errors", "context", "usage", "model", "provider"]) {
    expect(filterSessionsByQuery([populated, empty], `has:${value}`)).toEqual({
      sessions: [populated],
      warnings: [],
    });
  }
  expect(filterSessionsByQuery([populated, empty], "has:__proto__")).toEqual({
    sessions: [populated, empty],
    warnings: ["Unknown has:__proto__"],
  });
});

it("rejects non-decimal numbers and warns on unknown keys", () => {
  const target = makeSession("a", { totalTokens: 10_000, totalCost: 0 });
  for (const value of ["1e3", "0x1000", "9007199254740993", "wat"]) {
    const unknown = value === "wat";
    const query = `${unknown ? "__proto__:1 " : ""}minTokens:${value}`;
    expect(filterSessionsByQuery([target], query).warnings).toEqual([
      ...(unknown ? ["Unknown filter: __proto__"] : []),
      "Invalid number for minTokens",
    ]);
  }
});
