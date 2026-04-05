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
  sliceUtf16Safe,
  truncateUtf16Safe,
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
    await withTempDir("openclaw-test-", async (tmp) => {
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
  it("prefers ~/.openclaw when legacy dir is missing", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-config-dir-"));
    try {
      const newDir = path.join(root, ".openclaw");
      await fs.promises.mkdir(newDir, { recursive: true });
      const resolved = resolveConfigDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it("expands OPENCLAW_STATE_DIR using the provided env", () => {
    const env = {
      HOME: "/tmp/openclaw-home",
      OPENCLAW_STATE_DIR: "~/state",
    } as NodeJS.ProcessEnv;

    expect(resolveConfigDir(env)).toBe(path.resolve("/tmp/openclaw-home", "state"));
  });
});

describe("resolveHomeDir", () => {
  it("prefers OPENCLAW_HOME over HOME", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    expect(resolveHomeDir()).toBe(path.resolve("/srv/openclaw-home"));

    vi.unstubAllEnvs();
  });
});

describe("shortenHomePath", () => {
  it("uses $OPENCLAW_HOME prefix when OPENCLAW_HOME is set", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    expect(shortenHomePath(`${path.resolve("/srv/openclaw-home")}/.openclaw/openclaw.json`)).toBe(
      "$OPENCLAW_HOME/.openclaw/openclaw.json",
    );

    vi.unstubAllEnvs();
  });
});

describe("shortenHomeInString", () => {
  it("uses $OPENCLAW_HOME replacement when OPENCLAW_HOME is set", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    expect(
      shortenHomeInString(`config: ${path.resolve("/srv/openclaw-home")}/.openclaw/openclaw.json`),
    ).toBe("config: $OPENCLAW_HOME/.openclaw/openclaw.json");

    vi.unstubAllEnvs();
  });
});

describe("resolveUserPath", () => {
  it("expands ~ to home dir", () => {
    expect(resolveUserPath("~", {}, () => "/Users/thoffman")).toBe(path.resolve("/Users/thoffman"));
  });

  it("expands ~/ to home dir", () => {
    expect(resolveUserPath("~/openclaw", {}, () => "/Users/thoffman")).toBe(
      path.resolve("/Users/thoffman", "openclaw"),
    );
  });

  it("resolves relative paths", () => {
    expect(resolveUserPath("tmp/dir")).toBe(path.resolve("tmp/dir"));
  });

  it("prefers OPENCLAW_HOME for tilde expansion", () => {
    vi.stubEnv("OPENCLAW_HOME", "/srv/openclaw-home");
    vi.stubEnv("HOME", "/home/other");

    expect(resolveUserPath("~/openclaw")).toBe(path.resolve("/srv/openclaw-home", "openclaw"));

    vi.unstubAllEnvs();
  });

  it("uses the provided env for tilde expansion", () => {
    const env = {
      HOME: "/tmp/openclaw-home",
      OPENCLAW_HOME: "/srv/openclaw-home",
    } as NodeJS.ProcessEnv;

    expect(resolveUserPath("~/openclaw", env)).toBe(path.resolve("/srv/openclaw-home", "openclaw"));
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

describe("sliceUtf16Safe", () => {
  it("slices ASCII strings normally", () => {
    expect(sliceUtf16Safe("hello", 1, 4)).toBe("ell");
  });

  it("does not split a surrogate pair when start lands on low surrogate", () => {
    // '😀' is U+1F600, encoded as two UTF-16 code units: \uD83D\uDE00
    const s = "a😀b";
    // s.length === 4: 'a'(0), \uD83D(1), \uDE00(2), 'b'(3)
    // slicing at start=2 would land on the low surrogate; should skip to 3
    expect(sliceUtf16Safe(s, 2)).toBe("b");
  });

  it("does not split a surrogate pair when end lands between pair", () => {
    const s = "a😀b";
    // end=2 means the high surrogate at index 1 would be orphaned; should back up to 1
    expect(sliceUtf16Safe(s, 0, 2)).toBe("a");
  });

  it("handles negative indices", () => {
    expect(sliceUtf16Safe("hello", -3)).toBe("llo");
    expect(sliceUtf16Safe("hello", -3, -1)).toBe("ll");
  });

  it("returns the full string when no bounds given", () => {
    expect(sliceUtf16Safe("abc", 0)).toBe("abc");
  });

  it("returns empty for out-of-range start", () => {
    expect(sliceUtf16Safe("abc", 10)).toBe("");
  });

  it("swaps reversed from/to", () => {
    expect(sliceUtf16Safe("hello", 3, 1)).toBe("el");
  });
});

describe("truncateUtf16Safe", () => {
  it("returns the original string when within limit", () => {
    expect(truncateUtf16Safe("hello", 10)).toBe("hello");
  });

  it("truncates ASCII to the limit", () => {
    expect(truncateUtf16Safe("hello", 3)).toBe("hel");
  });

  it("does not orphan a surrogate pair at the truncation boundary", () => {
    const s = "a😀b"; // length 4
    // limit=2 would cut between the surrogate pair; should back up
    expect(truncateUtf16Safe(s, 2)).toBe("a");
  });

  it("handles zero and negative limits", () => {
    expect(truncateUtf16Safe("hello", 0)).toBe("");
    expect(truncateUtf16Safe("hello", -1)).toBe("");
  });

  it("handles empty string", () => {
    expect(truncateUtf16Safe("", 5)).toBe("");
  });
});
