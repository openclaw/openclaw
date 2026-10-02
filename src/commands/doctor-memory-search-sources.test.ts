import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectMemorySearchHealthFindings } from "./doctor-memory-search.js";

vi.mock("../plugins/memory-runtime.js", () => ({
  resolveActiveMemoryBackendConfig: () => ({ backend: "builtin" }),
}));

function config(sessionMemory: boolean): OpenClawConfig {
  return {
    agents: { list: [{ id: "main", default: true }] },
    memory: {
      search: {
        provider: "none",
        sources: ["memory", "sessions"],
        rememberAcrossConversations: false,
        experimental: { sessionMemory },
      },
    },
  };
}

async function findings(cfg: OpenClawConfig) {
  return collectMemorySearchHealthFindings({
    mode: "lint",
    cfg,
    env: { OPENCLAW_STATE_DIR: "/isolated-memory-state" },
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
  });
}

it("names the missing session-indexing prerequisite in Doctor", async () => {
  const result = await findings(config(false));

  expect(result).toContainEqual(
    expect.objectContaining({
      severity: "warning",
      path: "memory.search.sources",
      message: expect.stringContaining('requests the "sessions" source'),
    }),
  );
  expect(result[0]?.message).toContain("memory.search.experimental.sessionMemory");
  expect(result[0]?.message).toContain("memory.search.rememberAcrossConversations");
});

it("does not warn when session indexing is enabled", async () => {
  expect(await findings(config(true))).toEqual([]);
});
