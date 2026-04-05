import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureDir,
  resolveConfigDir,
  resolveHomeDir,
  resolveUserPath,
  shortenHomeInString,
  shortenHomePath,
  sleep,
} from "./utils.js";

async function withTempDir<T>(
  prefix: string,
  run: (dir: string) => T | Promise<T>,
): Promise<Awaited<T>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("ensureDir", () => {
  it("creates nested directory", async () => {
    await withTempDir("mullusi-test-", async (tmp) => {
      const target = path.join(tmp, "nested", "dir");
      await ensureDir(target);
      expect(fs.existsSync(target)).toBe(true);
    });
  });
});

describe("sleep", () => {
  it("resolves after delay using fake timers", async () => {
    vi.useFakeTimers();
    const promise = sleep(1000);
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toBeUndefined();
    vi.useRealTimers();
  });
});

describe("resolveConfigDir", () => {
  it("prefers ~/.mullusi when legacy dir is missing", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mullusi-config-dir-"));
    try {
      const newDir = path.join(root, ".mullusi");
      await fs.promises.mkdir(newDir, { recursive: true });
      const resolved = resolveConfigDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("expands MULLUSI_STATE_DIR using the provided env", () => {
    const env = {
      HOME: "/tmp/mullusi-home",
      MULLUSI_STATE_DIR: "~/state",
    } as NodeJS.ProcessEnv;

    expect(resolveConfigDir(env)).toBe(path.resolve("/tmp/mullusi-home", "state"));
  });
});

describe("resolveHomeDir", () => {
  it("prefers MULLUSI_HOME over HOME", () => {
    vi.stubEnv("MULLUSI_HOME", "/srv/mullusi-home");
    vi.stubEnv("HOME", "/home/other");

    expect(resolveHomeDir()).toBe(path.resolve("/srv/mullusi-home"));

    vi.unstubAllEnvs();
  });
});

describe("shortenHomePath", () => {
  it("uses $MULLUSI_HOME prefix when MULLUSI_HOME is set", () => {
    vi.stubEnv("MULLUSI_HOME", "/srv/mullusi-home");
    vi.stubEnv("HOME", "/home/other");

    expect(shortenHomePath(`${path.resolve("/srv/mullusi-home")}/.mullusi/mullusi.json`)).toBe(
      "$MULLUSI_HOME/.mullusi/mullusi.json",
    );

    vi.unstubAllEnvs();
  });
});

describe("shortenHomeInString", () => {
  it("uses $MULLUSI_HOME replacement when MULLUSI_HOME is set", () => {
    vi.stubEnv("MULLUSI_HOME", "/srv/mullusi-home");
    vi.stubEnv("HOME", "/home/other");

    expect(
      shortenHomeInString(`config: ${path.resolve("/srv/mullusi-home")}/.mullusi/mullusi.json`),
    ).toBe("config: $MULLUSI_HOME/.mullusi/mullusi.json");

    vi.unstubAllEnvs();
  });
});

describe("resolveUserPath", () => {
  it("expands ~ to home dir", () => {
    expect(resolveUserPath("~", {}, () => "/Users/thoffman")).toBe(path.resolve("/Users/thoffman"));
  });

  it("expands ~/ to home dir", () => {
    expect(resolveUserPath("~/mullusi", {}, () => "/Users/thoffman")).toBe(
      path.resolve("/Users/thoffman", "mullusi"),
    );
  });

  it("resolves relative paths", () => {
    expect(resolveUserPath("tmp/dir")).toBe(path.resolve("tmp/dir"));
  });

  it("prefers MULLUSI_HOME for tilde expansion", () => {
    vi.stubEnv("MULLUSI_HOME", "/srv/mullusi-home");
    vi.stubEnv("HOME", "/home/other");

    expect(resolveUserPath("~/mullusi")).toBe(path.resolve("/srv/mullusi-home", "mullusi"));

    vi.unstubAllEnvs();
  });

  it("uses the provided env for tilde expansion", () => {
    const env = {
      HOME: "/tmp/mullusi-home",
      MULLUSI_HOME: "/srv/mullusi-home",
    } as NodeJS.ProcessEnv;

    expect(resolveUserPath("~/mullusi", env)).toBe(path.resolve("/srv/mullusi-home", "mullusi"));
  });

  it("keeps blank paths blank", () => {
    expect(resolveUserPath("")).toBe("");
    expect(resolveUserPath("   ")).toBe("");
  });

  it("returns empty string for undefined/null input", () => {
    expect(resolveUserPath(undefined as unknown as string)).toBe("");
    expect(resolveUserPath(null as unknown as string)).toBe("");
  });
});
