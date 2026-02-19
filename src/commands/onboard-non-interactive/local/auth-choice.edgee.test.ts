import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyNonInteractiveAuthChoice } from "./auth-choice.js";

describe("applyNonInteractiveAuthChoice (edgee)", () => {
  const previousAgentDir = process.env.OPENCLAW_AGENT_DIR;
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    if (previousAgentDir === undefined) {
      delete process.env.OPENCLAW_AGENT_DIR;
    } else {
      process.env.OPENCLAW_AGENT_DIR = previousAgentDir;
    }
  });

  it("applies edgee config with non-interactive --edgee-api-key", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-edgee-ni-"));
    process.env.OPENCLAW_AGENT_DIR = tempDir;

    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    const next = await applyNonInteractiveAuthChoice({
      nextConfig: {},
      authChoice: "edgee-api-key",
      opts: { edgeeApiKey: "edgee-ni-key" },
      runtime,
      baseConfig: {},
    });

    expect(next).not.toBeNull();
    expect((next?.agents?.defaults?.model as { primary?: string } | undefined)?.primary).toBe(
      "edgee/openai/gpt-4o",
    );
    expect(next?.auth?.profiles?.["edgee:default"]).toMatchObject({
      provider: "edgee",
      mode: "api_key",
    });
  });
});
