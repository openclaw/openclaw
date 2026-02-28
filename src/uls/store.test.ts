/**
 * ULS Store & Vector Index — Unit Tests
 */

import { describe, expect, it } from "vitest";
import { SimpleVectorIndex, UlsStore, hashInput } from "./store.js";
import type { UlsRecord, UlsConfig } from "./types.js";
import { ULS_SCHEMA_VERSION, DEFAULT_ULS_CONFIG } from "./types.js";

function makeRecord(overrides?: Partial<UlsRecord>): UlsRecord {
  return {
    schemaVersion: ULS_SCHEMA_VERSION,
    recordId: `rec-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "agent-a",
    timestamp: Date.now(),
    modality: "tool_result",
    ut: {},
    pPublic: { summary: "test record" },
    tags: ["test"],
    riskFlags: [],
    scope: "global",
    acl: {},
    provenance: { inputHash: hashInput("test-input") },
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<UlsConfig>): UlsConfig {
  return {
    ...DEFAULT_ULS_CONFIG,
    enabled: true,
    storagePath: "",
    ...overrides,
  };
}

describe("SimpleVectorIndex", () => {
  it("adds and searches documents", () => {
    const index = new SimpleVectorIndex();
    index.add("doc-1", "typescript generics tutorial advanced patterns");
    index.add("doc-2", "python machine learning neural networks");
    index.add("doc-3", "typescript react hooks state management");

    const results = index.search("typescript patterns", 2);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].recordId).toBe("doc-1");
  });

  it("returns empty for unrelated queries", () => {
    const index = new SimpleVectorIndex();
    index.add("doc-1", "cooking recipes italian pasta");
    const results = index.search("quantum physics entanglement", 5);
    expect(results).toHaveLength(0);
  });

  it("respects top_k limit", () => {
    const index = new SimpleVectorIndex();
    for (let i = 0; i < 20; i++) {
      index.add(`doc-${i}`, `typescript generics type inference number ${i}`);
    }
    const results = index.search("typescript", 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it("removes documents", () => {
    const index = new SimpleVectorIndex();
    index.add("doc-1", "hello world test");
    expect(index.size).toBe(1);
    index.remove("doc-1");
    expect(index.size).toBe(0);
  });
});

describe("UlsStore", () => {
  it("stores and retrieves records", async () => {
    const store = new UlsStore(); // in-memory
    const config = makeConfig();

    const record = makeRecord({
      agentId: "agent-a",
      scope: "global",
      pPublic: { summary: "deployed service X" },
      tags: ["deployment"],
    });

    await store.store(record);
    expect(store.size).toBe(1);

    const result = await store.retrieve(
      { agentId: "agent-b", query: "deployment service", scope: "global", topK: 5 },
      config,
    );
    expect(result.records.length).toBe(1);
    expect(result.records[0].pPublic.summary).toBe("deployed service X");
  });

  it("enforces scope filtering — team records hidden from global query", async () => {
    const store = new UlsStore();
    const config = makeConfig({
      teamGroups: { devs: ["agent-a"] },
    });

    await store.store(
      makeRecord({ scope: "team", pPublic: { summary: "team secret" }, tags: ["team"] }),
    );

    // global scope query should not return team-scoped records
    const result = await store.retrieve(
      { agentId: "agent-a", query: "team secret", scope: "global", topK: 5 },
      config,
    );
    expect(result.records.length).toBe(0);
  });

  it("enforces ACL — denies access to denied agents", async () => {
    const store = new UlsStore();
    const config = makeConfig();

    await store.store(
      makeRecord({
        scope: "global",
        acl: { deny: ["agent-blocked"] },
        pPublic: { summary: "restricted data" },
      }),
    );

    const blocked = await store.retrieve(
      { agentId: "agent-blocked", query: "restricted data", scope: "global", topK: 5 },
      config,
    );
    expect(blocked.records.length).toBe(0);

    const allowed = await store.retrieve(
      { agentId: "agent-ok", query: "restricted data", scope: "global", topK: 5 },
      config,
    );
    expect(allowed.records.length).toBe(1);
  });

  it("filters by tags when specified", async () => {
    const store = new UlsStore();
    const config = makeConfig();

    await store.store(makeRecord({ tags: ["deploy"], pPublic: { summary: "deploy event" } }));
    await store.store(makeRecord({ tags: ["monitor"], pPublic: { summary: "monitor event" } }));

    const result = await store.retrieve(
      { agentId: "agent-a", query: "event", scope: "global", topK: 5, tags: ["deploy"] },
      config,
    );
    expect(result.records.length).toBe(1);
    expect(result.records[0].tags).toContain("deploy");
  });

  it("returns provenance and risk flags in results", async () => {
    const store = new UlsStore();
    const config = makeConfig();

    await store.store(
      makeRecord({
        riskFlags: ["injection_suspect"],
        provenance: { sourceTool: "web_fetch", inputHash: "abc123" },
        pPublic: { summary: "suspicious content" },
      }),
    );

    const result = await store.retrieve(
      { agentId: "agent-b", query: "suspicious", scope: "global", topK: 5 },
      config,
    );
    expect(result.records[0].riskFlags).toContain("injection_suspect");
    expect(result.records[0].provenance.sourceTool).toBe("web_fetch");
  });
});

describe("hashInput", () => {
  it("produces consistent hashes", () => {
    expect(hashInput("hello")).toBe(hashInput("hello"));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashInput("hello")).not.toBe(hashInput("world"));
  });

  it("returns a 32-char hex string", () => {
    const h = hashInput("test");
    expect(h).toMatch(/^[a-f0-9]{32}$/);
  });
});
