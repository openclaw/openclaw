import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import dotenv from "dotenv";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDotEnv } from "./dotenv.js";

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("expands references from the shell and CWD env files", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        process.env.OPENAI_API_KEY = "from-shell";
        await writeEnvFile(path.join(cwdDir, ".env"), "LOCAL_BASE=from-cwd\n");
        await writeEnvFile(
          path.join(stateDir, ".env"),
          "OPENAI_TRANSCRIPTION_API_KEY=${OPENAI_API_KEY}\nCHAINED_VALUE=${LOCAL_BASE}\n",
        );

        process.chdir(cwdDir);
        delete process.env.OPENAI_TRANSCRIPTION_API_KEY;
        delete process.env.CHAINED_VALUE;

        loadDotEnv({ quiet: true });

        expect(process.env.OPENAI_TRANSCRIPTION_API_KEY).toBe("from-shell");
        expect(process.env.CHAINED_VALUE).toBe("from-cwd");
      });
    });
  });

  it("expands references defined earlier in the same env file", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(
          path.join(stateDir, ".env"),
          "BASE=from-global\nCOMBINED=${BASE}-suffix\n",
        );
        process.chdir(cwdDir);
        delete process.env.BASE;
        delete process.env.COMBINED;

        loadDotEnv({ quiet: true });

        expect(process.env.BASE).toBe("from-global");
        expect(process.env.COMBINED).toBe("from-global-suffix");
      });
    });
  });

  it("keeps loading fallback env files when a prior env file fails to parse", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(path.join(cwdDir, ".env"), "BROKEN=1\n");
        await writeEnvFile(path.join(stateDir, ".env"), "FALLBACK_OK=from-global\n");
        process.chdir(cwdDir);
        delete process.env.FALLBACK_OK;

        const configSpy = vi.spyOn(dotenv, "configDotenv");
        configSpy.mockImplementation((options) => {
          if (typeof options?.path === "string" && options.path === path.join(cwdDir, ".env")) {
            return { parsed: {}, error: new Error("boom") };
          }
          return { parsed: { FALLBACK_OK: "from-global" } };
        });

        expect(() => loadDotEnv({ quiet: true })).not.toThrow();
        expect(process.env.FALLBACK_OK).toBe("from-global");
      });
    });
  });
});
