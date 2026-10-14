import { describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../../../config/legacy.js";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";

function migrate(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}
function memorySearch(search: Record<string, unknown>) {
  return { memory: { search } };
}
function collection(path: string, pattern?: string) {
  return { extraCollections: [{ path, ...(pattern ? { pattern } : {}) }] };
}
const sessionMemory = { memory: { search: { qmd: { sessions: { enabled: true } } } } };

describe("retired QMD memory migration", () => {
  it("preserves builtin siblings and imports external paths without altering a shadowed roster", () => {
    const list = [{ id: "legacy", memory: { search: { qmd: collection("/tmp/list") } } }];
    const raw = {
      memory: {
        backend: "qmd",
        citations: "on",
        qmd: {
          sessions: { enabled: true },
          paths: [
            { path: "/tmp/global" },
            { path: "/tmp/patterned", pattern: "notes/*.md" },
            { path: " /tmp/shared ", pattern: "**/*.md" },
            { path: " " },
          ],
        },
        search: {
          provider: "openai",
          extraPaths: ["notes", "/tmp/shared"],
          qmd: collection("/tmp/search"),
        },
      },
      agents: {
        defaults: memorySearch({
          extraPaths: ["notes"],
          qmd: collection("/tmp/defaults"),
        }),
        entries: {
          research: memorySearch({
            enabled: false,
            extraPaths: ["/tmp/existing"],
            qmd: collection("/tmp/research", "*.md"),
          }),
        },
        list: structuredClone(list),
      },
    };
    const issues = findLegacyConfigIssues(raw);
    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        "memory.backend",
        "memory.qmd",
        "memory.search.qmd",
        "agents.defaults.memory.search.qmd",
        "agents.entries",
        "agents.list",
      ]),
    );
    expect(issues.every((issue) => issue.message.includes("doctor --fix"))).toBe(true);
    const result = migrate(raw);
    expect(result.raw).toEqual({
      memory: {
        citations: "on",
        search: {
          provider: "openai",
          experimental: { sessionMemory: true },
          sources: ["memory", "sessions"],
          extraPaths: [
            "notes",
            "/tmp/shared",
            "/tmp/global",
            { path: "/tmp/patterned", pattern: "notes/*.md" },
            { path: "/tmp/shared", pattern: "**/*.md" },
            "/tmp/search",
            "/tmp/defaults",
          ],
        },
      },
      agents: {
        defaults: {},
        entries: {
          research: memorySearch({
            enabled: false,
            extraPaths: ["/tmp/existing", { path: "/tmp/research", pattern: "*.md" }],
          }),
        },
        list,
      },
    });
    expect(migrate(result.raw).changes).toEqual([]);
  });

  it.each([
    { raw: { agents: { defaults: sessionMemory } }, target: "memory.search" },
    {
      raw: { agents: { entries: { research: sessionMemory } } },
      target: "agents.entries.research.memory.search",
    },
    {
      raw: { agents: { list: [{ id: "research", ...sessionMemory }] } },
      target: "agents.list.0.memory.search",
    },
  ])("preserves explicit transcript indexing at $target", ({ raw, target }) => {
    const result = migrate(structuredClone(raw));
    expect(result.raw).toHaveProperty(`${target}.experimental.sessionMemory`, true);
    expect(result.raw).toHaveProperty(`${target}.sources`, ["memory", "sessions"]);
    expect(result.raw).not.toHaveProperty(`${target}.rememberAcrossConversations`);
    expect(migrate(result.raw).changes).toEqual([]);
  });

  it.each([{ sources: [] }, { sources: ["memory"] }])(
    "preserves privacy opt-outs while merging sources=$sources",
    ({ sources }) => {
      const result = migrate({
        memory: {
          qmd: { sessions: { enabled: true } },
          search: {
            rememberAcrossConversations: false,
            experimental: { sessionMemory: false },
            sources: [...sources],
          },
        },
      });
      expect(result.raw).toHaveProperty("memory.search", {
        rememberAcrossConversations: false,
        experimental: { sessionMemory: false },
        sources: ["memory", "sessions"],
      });
    },
  );

  it("does not enable builtin sessions for disabled QMD indexing", () => {
    const result = migrate({ memory: { qmd: { sessions: { enabled: false } } } });
    expect(result.raw).not.toHaveProperty("memory.search.experimental.sessionMemory");
    expect(result.raw).not.toHaveProperty("memory.search.sources");
  });
});
