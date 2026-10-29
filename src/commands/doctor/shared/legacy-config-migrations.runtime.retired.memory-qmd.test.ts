import { expect, it } from "vitest";
import { setConfigValueAtPath } from "../../../config/config-paths.js";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";

function migrate(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}
function memorySearch(search: Record<string, unknown>, qmd?: Record<string, unknown>) {
  return { memory: { search: { ...search, ...(qmd ? { qmd } : {}) } } };
}
function collection(path: string, pattern?: string) {
  return { extraCollections: [{ path, ...(pattern ? { pattern } : {}) }] };
}
function config(paths: Record<string, unknown>) {
  const raw = {};
  for (const [path, value] of Object.entries(paths)) {
    setConfigValueAtPath(raw, path.split("."), value);
  }
  return raw;
}
const sessionMemory = { memory: { search: { qmd: { sessions: { enabled: true } } } } };
const sessionIndex = { experimental: { sessionMemory: true }, sources: ["memory", "sessions"] };
const optedOut = { rememberAcrossConversations: false, experimental: { sessionMemory: false } };

it("preserves builtin siblings and imports external paths without altering a shadowed roster", () => {
  const list = [{ id: "legacy", ...memorySearch({}, collection("/tmp/list")) }];
  const existing = { provider: "openai", extraPaths: ["notes", "/tmp/shared"] };
  const research = { enabled: false, extraPaths: ["/tmp/existing"] };
  const raw = config({
    "memory.backend": "qmd",
    "memory.citations": "on",
    "memory.qmd": {
      sessions: { enabled: true },
      paths: [
        { path: "/tmp/global" },
        { path: "/tmp/patterned", pattern: "notes/*.md" },
        { path: " /tmp/shared ", pattern: "**/*.md" },
        { path: " " },
      ],
    },
    "memory.search": { ...structuredClone(existing), qmd: collection("/tmp/search") },
    "agents.defaults": memorySearch({ extraPaths: ["notes"] }, collection("/tmp/defaults")),
    "agents.entries.research": memorySearch(
      structuredClone(research),
      collection("/tmp/research", "*.md"),
    ),
    "agents.list": structuredClone(list),
  });
  const issues = findLegacyConfigIssues(raw);
  expect(issues.length).toBeGreaterThan(0);
  expect(issues.every((issue) => issue.message.includes("doctor --fix"))).toBe(true);
  const result = migrate(raw);
  expect(result.raw).toEqual(
    config({
      "memory.citations": "on",
      "memory.search": {
        ...existing,
        ...sessionIndex,
        extraPaths: [
          ...existing.extraPaths,
          "/tmp/global",
          { path: "/tmp/patterned", pattern: "notes/*.md" },
          { path: "/tmp/shared", pattern: "**/*.md" },
          "/tmp/search",
          "/tmp/defaults",
        ],
      },
      "agents.defaults": {},
      "agents.entries.research": memorySearch({
        ...research,
        extraPaths: [...research.extraPaths, { path: "/tmp/research", pattern: "*.md" }],
      }),
      "agents.list": list,
    }),
  );
  expect(migrate(result.raw).changes).toEqual([]);
});

const scopes: [string, Record<string, unknown>][] = [
  ["memory.search", { defaults: sessionMemory }],
  ["agents.entries.research.memory.search", { entries: { research: sessionMemory } }],
  ["agents.list.0.memory.search", { list: [{ id: "research", ...sessionMemory }] }],
];
it.each(scopes)("preserves explicit transcript indexing at %s", (target, agents) => {
  const result = migrate({ agents: structuredClone(agents) });
  expect(result.raw).toHaveProperty(target, expect.objectContaining(sessionIndex));
  expect(result.raw).not.toHaveProperty(`${target}.rememberAcrossConversations`);
  expect(migrate(result.raw).changes).toEqual([]);
});

it.each([[[]], [["memory"]]])("preserves privacy opt-outs for %j", (sources) => {
  const result = migrate({
    memory: {
      qmd: { sessions: { enabled: true } },
      search: {
        ...structuredClone(optedOut),
        sources: [...sources],
      },
    },
  });
  expect(result.raw).toHaveProperty("memory.search", {
    ...optedOut,
    sources: ["memory", "sessions"],
  });
});

it("does not enable builtin sessions for disabled QMD indexing", () => {
  const result = migrate({ memory: { qmd: { sessions: { enabled: false } } } });
  expect(result.raw).not.toHaveProperty("memory.search.experimental.sessionMemory");
  expect(result.raw).not.toHaveProperty("memory.search.sources");
});
