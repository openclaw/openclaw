import { expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectMemorySearchHealthFindings,
  noteMemorySearchHealth,
} from "./doctor-memory-search.js";

// mock-isolation: capture Doctor notes without writing to the interactive terminal.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));

// mock-isolation: select the built-in backend without activating real plugin runtimes.
vi.mock("../plugins/memory-runtime.js", () => ({
  resolveActiveMemoryBackendConfig: () => ({ backend: "builtin" }),
}));

function config(sessionMemory: boolean): OpenClawConfig {
  return {
    agents: { entries: { main: {} } },
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

it.each([false, true])(
  "explains excluded sources without failing lint (sessionMemory=%s)",
  async (sessionMemory) => {
    const cfg = config(sessionMemory);
    vi.mocked(note).mockClear();
    await noteMemorySearchHealth(cfg, { includeWorkspaceMemoryHealth: false });
    if (sessionMemory) {
      expect(note).not.toHaveBeenCalled();
    } else {
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining('requests the "sessions" source'),
        "Memory search",
      );
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("memory.search.experimental.sessionMemory"),
        "Memory search",
      );
    }
    expect(await findings(cfg)).toEqual([]);
  },
);
