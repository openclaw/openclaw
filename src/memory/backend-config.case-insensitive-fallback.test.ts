import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";

const TMP = path.join(os.tmpdir(), "openclaw-memory-backend-config-tests");

function makeCfg(workspace: string): OpenClawConfig {
  return {
    agents: { defaults: { workspace } },
    memory: { backend: "qmd", qmd: {} },
  } as OpenClawConfig;
}

describe("resolveMemoryBackendConfig (MEMORY.md canonical)", () => {
  beforeEach(() => {
    fsSync.rmSync(TMP, { recursive: true, force: true });
    fsSync.mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  });

  it("includes memory.md collection only when MEMORY.md is absent", () => {
    const cfg1 = makeCfg(TMP);

    // With no MEMORY.md present, we should fall back to watching/including memory.md.
    const resolved1 = resolveMemoryBackendConfig({ cfg: cfg1, agentId: "main" });
    const patterns1 = new Set(resolved1.qmd?.collections.map((c) => c.pattern) ?? []);
    expect(patterns1.has("MEMORY.md")).toBe(true);
    expect(patterns1.has("memory.md")).toBe(true);

    // Create MEMORY.md, now memory.md should not be included.
    fsSync.writeFileSync(path.join(TMP, "MEMORY.md"), "# Memory\n");
    const cfg2 = makeCfg(TMP);
    const resolved2 = resolveMemoryBackendConfig({ cfg: cfg2, agentId: "main" });
    const patterns2 = new Set(resolved2.qmd?.collections.map((c) => c.pattern) ?? []);
    expect(patterns2.has("MEMORY.md")).toBe(true);
    expect(patterns2.has("memory.md")).toBe(false);
  });
});
