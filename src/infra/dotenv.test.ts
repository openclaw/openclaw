import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnv, loadWorkspaceDotEnvFile } from "./dotenv.js";

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

  it("blocks dangerous host env vars from CWD .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "SAFE_KEY=from-cwd",
            "NODE_OPTIONS=--require ./evil.js",
            "HTTP_PROXY=http://evil-proxy:8080",
          ].join("\n"),
        );
        await writeEnvFile(path.join(stateDir, ".env"), "BAR=from-global\n");

        process.chdir(cwdDir);
        delete process.env.SAFE_KEY;
        delete process.env.NODE_OPTIONS;
        delete process.env.HTTP_PROXY;

        loadDotEnv({ quiet: true });

        expect(process.env.SAFE_KEY).toBe("from-cwd");
        expect(process.env.BAR).toBe("from-global");
        expect(process.env.NODE_OPTIONS).toBeUndefined();
        expect(process.env.HTTP_PROXY).toBeUndefined();
      });
    });
  });

  it("blocks relative OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH from CWD .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          ["OPENCLAW_STATE_DIR=./evil-state", "OPENCLAW_CONFIG_PATH=./evil-config.json"].join("\n"),
        );
        await writeEnvFile(path.join(stateDir, ".env"), "BAR=from-global\n");

        process.chdir(cwdDir);
        delete process.env.OPENCLAW_CONFIG_PATH;

        loadDotEnv({ quiet: true });

        // Relative OPENCLAW_STATE_DIR is blocked (security: prevents redirecting state dir)
        expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
        // Relative OPENCLAW_CONFIG_PATH is blocked (security: prevents redirecting config)
        expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
      });
    });
  });

  it("allows absolute OPENCLAW_CONFIG_PATH and OPENCLAW_STATE_DIR from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, base }) => {
        const absoluteStateDir = path.join(base, "my-custom-state");
        const absoluteConfigPath = path.join(base, "my-config", "openclaw.runtime.json5");
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            `OPENCLAW_STATE_DIR=${absoluteStateDir}`,
            `OPENCLAW_CONFIG_PATH=${absoluteConfigPath}`,
          ].join("\n"),
        );

        delete process.env.OPENCLAW_STATE_DIR;
        delete process.env.OPENCLAW_CONFIG_PATH;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        // Absolute paths are allowed: users legitimately configure these in project-local .env
        expect(process.env.OPENCLAW_STATE_DIR).toBe(absoluteStateDir);
        expect(process.env.OPENCLAW_CONFIG_PATH).toBe(absoluteConfigPath);
      });
    });
  });

  it("blocks relative path values for OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH even when unset", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          "OPENCLAW_STATE_DIR=./evil-state\nOPENCLAW_CONFIG_PATH=./evil-config.json\n",
        );

        delete process.env.OPENCLAW_STATE_DIR;
        delete process.env.OPENCLAW_CONFIG_PATH;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
        expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
      });
    });
  });
});
