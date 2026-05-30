import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readStateDirDotEnvVarsFromStateDir } from "./state-dir-dotenv.js";

describe("readStateDirDotEnvVarsFromStateDir", () => {
  async function withDotEnv<T>(content: string, run: (dir: string) => T | Promise<T>): Promise<T> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-test-"));
    await fs.writeFile(path.join(dir, ".env"), content, "utf8");
    try {
      return await run(dir);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it("returns real credential values from the state-dir dotenv", async () => {
    await withDotEnv("SUPERMEMORY_API_KEY=sm_real_credential_value\n", async (dir) => {
      const result = readStateDirDotEnvVarsFromStateDir(dir);
      expect(result["SUPERMEMORY_API_KEY"]).toBe("sm_real_credential_value");
    });
  });

  it("skips values that are unresolved shell variable references", async () => {
    const content = [
      'SUPERMEMORY_OPENCLAW_API_KEY="${SUPERMEMORY_OPENCLAW_KEY}"',
      "OTHER_KEY=$SOME_SHELL_VAR",
      "CURLY_KEY=${ANOTHER_VAR}",
      "REAL_KEY=actual_value_here",
    ].join("\n");

    await withDotEnv(content, async (dir) => {
      const result = readStateDirDotEnvVarsFromStateDir(dir);
      expect(Object.keys(result)).not.toContain("SUPERMEMORY_OPENCLAW_API_KEY");
      expect(Object.keys(result)).not.toContain("OTHER_KEY");
      expect(Object.keys(result)).not.toContain("CURLY_KEY");
      expect(result["REAL_KEY"]).toBe("actual_value_here");
    });
  });

  it("returns empty object when .env is missing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-missing-"));
    try {
      expect(readStateDirDotEnvVarsFromStateDir(dir)).toEqual({});
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
