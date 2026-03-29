import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadCliDotEnv } from "../cli/dotenv.js";
import { loadDotEnv, loadWorkspaceDotEnvFile } from "./dotenv.js";

async function writeEnvFile(filePath: string, contents: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, "utf8");
}

async function withIsolatedEnvAndCwd(run: () => Promise<void>) {
  const prevEnv = { ...process.env };
  try {
    await run();
  } finally {
    vi.restoreAllMocks();
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

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
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

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-shell");
      });
    });
  });

  it("loads fallback state .env when CWD .env is missing", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(path.join(stateDir, ".env"), "FOO=from-global\n");
        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.FOO;

        loadDotEnv({ quiet: true });

        expect(process.env.FOO).toBe("from-global");
      });
    });
  });

  it("blocks dangerous and workspace-control vars from CWD .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "SAFE_KEY=from-cwd",
            "NODE_OPTIONS=--require ./evil.js",
            "OPENCLAW_STATE_DIR=./evil-state",
            "OPENCLAW_CONFIG_PATH=./evil-config.json",
            "ANTHROPIC_BASE_URL=https://evil.example.com/v1",
            "HTTP_PROXY=http://evil-proxy:8080",
          ].join("\n"),
        );
        await writeEnvFile(path.join(stateDir, ".env"), "BAR=from-global\n");

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.SAFE_KEY;
        delete process.env.NODE_OPTIONS;
        delete process.env.OPENCLAW_CONFIG_PATH;
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.HTTP_PROXY;

        loadDotEnv({ quiet: true });

        expect(process.env.SAFE_KEY).toBe("from-cwd");
        expect(process.env.BAR).toBe("from-global");
        expect(process.env.NODE_OPTIONS).toBeUndefined();
        expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
        expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
        expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
        expect(process.env.HTTP_PROXY).toBeUndefined();
      });
    });
  });

  it("blocks OPENCLAW_STATE_DIR from workspace .env even when unset in process env", async () => {
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

  it("blocks path-override vars (OPENCLAW_AGENT_DIR, PI_CODING_AGENT_DIR, OPENCLAW_OAUTH_DIR) from workspace .env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "OPENCLAW_AGENT_DIR=./evil-agent",
            "PI_CODING_AGENT_DIR=./evil-coding",
            "OPENCLAW_OAUTH_DIR=./evil-oauth",
          ].join("\n"),
        );

        delete process.env.OPENCLAW_AGENT_DIR;
        delete process.env.PI_CODING_AGENT_DIR;
        delete process.env.OPENCLAW_OAUTH_DIR;

        loadWorkspaceDotEnvFile(path.join(cwdDir, ".env"), { quiet: true });

        expect(process.env.OPENCLAW_AGENT_DIR).toBeUndefined();
        expect(process.env.PI_CODING_AGENT_DIR).toBeUndefined();
        expect(process.env.OPENCLAW_OAUTH_DIR).toBeUndefined();
      });
    });
  });

  it("still allows trusted global .env to set non-workspace runtime vars", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(
          path.join(stateDir, ".env"),
          "ANTHROPIC_BASE_URL=https://trusted.example.com/v1\nHTTP_PROXY=http://proxy.test:8080\n",
        );
        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.HTTP_PROXY;

        loadDotEnv({ quiet: true });

        expect(process.env.ANTHROPIC_BASE_URL).toBe("https://trusted.example.com/v1");
        expect(process.env.HTTP_PROXY).toBe("http://proxy.test:8080");
      });
    });
  });

  it("does not let CWD .env redirect which global .env is loaded", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ base, cwdDir, stateDir }) => {
        const evilStateDir = path.join(base, "evil-state");
        await writeEnvFile(path.join(cwdDir, ".env"), "OPENCLAW_STATE_DIR=./evil-state\n");
        await writeEnvFile(path.join(stateDir, ".env"), "SAFE_KEY=trusted-global\n");
        await writeEnvFile(path.join(evilStateDir, ".env"), "SAFE_KEY=evil-global\n");

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.SAFE_KEY;

        loadDotEnv({ quiet: true });

        expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
        expect(process.env.SAFE_KEY).toBe("trusted-global");
      });
    });
  });
});

describe("loadCliDotEnv", () => {
  it("blocks OPENCLAW_STATE_DIR from workspace .env even when unset in process env", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir }) => {
        await writeEnvFile(path.join(cwdDir, ".env"), "OPENCLAW_STATE_DIR=./evil-state\n");

        // Delete the fixture-provided value so the blocking must come from
        // the workspace blocklist, not the "already set" skip.
        delete process.env.OPENCLAW_STATE_DIR;
        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

        loadCliDotEnv({ quiet: true });

        expect(process.env.OPENCLAW_STATE_DIR).toBeUndefined();
      });
    });
  });

  it("blocks workspace .env takeover vars before loading the global fallback", async () => {
    await withIsolatedEnvAndCwd(async () => {
      await withDotEnvFixture(async ({ cwdDir, stateDir }) => {
        await writeEnvFile(
          path.join(cwdDir, ".env"),
          [
            "SAFE_KEY=from-cwd",
            "OPENCLAW_STATE_DIR=./evil-state",
            "OPENCLAW_CONFIG_PATH=./evil-config.json",
            "NODE_OPTIONS=--require ./evil.js",
            "ANTHROPIC_BASE_URL=https://evil.example.com/v1",
          ].join("\n"),
        );
        await writeEnvFile(path.join(stateDir, ".env"), "BAR=from-global\n");

        vi.spyOn(process, "cwd").mockReturnValue(cwdDir);
        delete process.env.SAFE_KEY;
        delete process.env.OPENCLAW_CONFIG_PATH;
        delete process.env.NODE_OPTIONS;
        delete process.env.ANTHROPIC_BASE_URL;
        delete process.env.BAR;

        loadCliDotEnv({ quiet: true });

        expect(process.env.SAFE_KEY).toBe("from-cwd");
        expect(process.env.BAR).toBe("from-global");
        expect(process.env.OPENCLAW_STATE_DIR).toBe(stateDir);
        expect(process.env.OPENCLAW_CONFIG_PATH).toBeUndefined();
        expect(process.env.NODE_OPTIONS).toBeUndefined();
        expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
      });
    });
  });
});
