import { execSync } from "node:child_process";
import fssync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnv, parseWorkspaceDotEnv } from "./dotenv.js";

async function writeEnvFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function withIsolatedEnvAndCwd(run: () => Promise<void>) {
  const prevEnv = { ...process.env };
  const prevCwd = process.cwd();
  try {
    await run();
  } finally {
    process.chdir(prevCwd);
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

type DotEnvFixture = {
  base: string;
  cwdDir: string;
  stateDir: string;
};

async function withDotEnvFixture(run: (fixture: DotEnvFixture) => Promise<void>) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dotenv-test-"));
  const cwdDir = path.join(base, "cwd");
  const stateDir = path.join(base, "state");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  await fs.mkdir(cwdDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  await run({ base, cwdDir, stateDir });
}

describe("loadDotEnv", () => {
  it("loads ~/.openclaw/.env as fallback without overriding CWD .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\nBAR=1\n");
        await writeEnvFile(path.join(cwdDir, ".env"), "FOO=from-cwd\n");

        process.chdir(cwdDir);
        delete process.env.FOO;
        delete process.env.BAR;

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-cwd");
        expect(process.env.BAR).toBe("1");
      });
    });
  });

  it("does not override an already-set env var from the shell", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        process.env.FOO = "from-shell";

        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
        await writeEnvFile(path.join(cwdDir, ".env"), "FOO=from-cwd\n");

        process.chdir(cwdDir);

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-shell");
      });
    });
  });

  it("loads fallback state .env when CWD .env is missing", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
        process.chdir(cwdDir);
        delete process.env.FOO;

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-global");
      });
    });
  });
});

describe("parseWorkspaceDotEnv", () => {
  it("parses workspace .env file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-env-"));
    try {
      await fs.writeFile(
        path.join(tmpDir, ".env"),
        "GH_CONFIG_DIR=/custom/path\nMY_VAR=hello\n",
        "utf8",
      );
      const result = parseWorkspaceDotEnv(tmpDir);
      expect(result).toEqual({ GH_CONFIG_DIR: "/custom/path", MY_VAR: "hello" });
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it("returns empty object when no .env exists", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-env-"));
    try {
      const result = parseWorkspaceDotEnv(tmpDir);
      expect(result).toEqual({});
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it("filters dangerous env keys", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-env-"));
    try {
      await fs.writeFile(
        path.join(tmpDir, ".env"),
        "SAFE_VAR=ok\nNODE_OPTIONS=--max-old-space-size=8192\nLD_PRELOAD=/evil.so\nDYLD_INSERT_LIBRARIES=/evil.dylib\n",
        "utf8",
      );
      const result = parseWorkspaceDotEnv(tmpDir);
      expect(result).toHaveProperty("SAFE_VAR", "ok");
      expect(result).not.toHaveProperty("NODE_OPTIONS");
      expect(result).not.toHaveProperty("LD_PRELOAD");
      expect(result).not.toHaveProperty("DYLD_INSERT_LIBRARIES");
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it("does not modify process.env", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-env-"));
    try {
      await fs.writeFile(
        path.join(tmpDir, ".env"),
        "OPENCLAW_WS_TEST_VAR=should-not-set\n",
        "utf8",
      );
      delete process.env.OPENCLAW_WS_TEST_VAR;
      parseWorkspaceDotEnv(tmpDir);
      expect(process.env.OPENCLAW_WS_TEST_VAR).toBeUndefined();
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it("returns empty object and does not block when .env is a FIFO", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-env-"));
    const envPath = path.join(tmpDir, ".env");
    try {
      // Create a named pipe; skip on platforms where mkfifo is unavailable.
      try {
        execSync(`mkfifo ${JSON.stringify(envPath)}`);
      } catch {
        return; // mkfifo unavailable – skip
      }
      // Must return immediately without blocking.
      const result = parseWorkspaceDotEnv(tmpDir);
      expect(result).toEqual({});
    } finally {
      // Remove the FIFO if it still exists (non-blocking unlink).
      try {
        fssync.unlinkSync(envPath);
      } catch {
        /* ignore */
      }
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty object when .env exceeds the size cap", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "ws-env-"));
    try {
      // Write a file larger than MAX_WORKSPACE_ENV_BYTES (1 MiB).
      const big = Buffer.alloc(1 * 1024 * 1024 + 1, "A");
      await fs.writeFile(path.join(tmpDir, ".env"), big);
      const result = parseWorkspaceDotEnv(tmpDir);
      expect(result).toEqual({});
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});
