// Tests shared utility helpers used by CLI and runtime modules.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "./shared/number-coercion.js";
import { withTempDir } from "./test-helpers/temp-dir.js";
import { withEnv } from "./test-utils/env.js";
import {
  CONFIG_DIR,
  ensureDir,
  normalizeE164,
  pinConfigDir,
  resolveConfigDir,
  resolveHomeDir,
  resolveUserPath,
  shortenHomeInString,
  shortenHomePath,
  sleep,
} from "./utils.js";

describe("normalizeE164", () => {
  it("normalizes phone-like input into loose E.164", () => {
    expect(normalizeE164("+1 (555) 234-5678")).toBe("+15552345678");
    expect(normalizeE164("15552345678")).toBe("+15552345678");
    expect(normalizeE164("tel:+1-555-234-5678")).toBe("+15552345678");
  });

  it("returns an empty string when there are no digits to normalize", () => {
    // Carriers report blocked caller id as a literal like "Anonymous", and a
    // bare scheme such as "sms://" carries no number. These must not collapse to
    // a stray "+" (not a valid E.164); returning "" lets callers fall back to
    // their own sentinel (e.g. `from || "unknown"`).
    expect(normalizeE164("Anonymous")).toBe("");
    expect(normalizeE164("sms://")).toBe("");
    expect(normalizeE164("")).toBe("");
    expect(normalizeE164("+")).toBe("");
  });
});

describe("ensureDir", () => {
  it("creates nested directory", async () => {
    await withTempDir({ prefix: "openclaw-test-" }, async (tmp) => {
      const target = path.join(tmp, "nested", "dir");
      await ensureDir(target);
      expect(fs.existsSync(target)).toBe(true);
    });
  });
});

describe("sleep", () => {
  it("resolves after delay using fake timers", async () => {
    vi.useFakeTimers();
    try {
      const promise = sleep(1000);
      vi.advanceTimersByTime(1000);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps oversized sleep delays before scheduling", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const promise = sleep(Number.MAX_SAFE_INTEGER);

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);

      vi.advanceTimersByTime(MAX_TIMER_TIMEOUT_MS);
      await expect(promise).resolves.toBeUndefined();
    } finally {
      setTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("resolveConfigDir", () => {
  it("prefers ~/.openclaw when legacy dir is missing", async () => {
    await withTempDir({ prefix: "openclaw-config-dir-" }, async (root) => {
      const newDir = path.join(root, ".openclaw");
      await fs.promises.mkdir(newDir, { recursive: true });
      const resolved = resolveConfigDir({} as NodeJS.ProcessEnv, () => root);
      expect(resolved).toBe(newDir);
    });
  });

  it("expands OPENCLAW_STATE_DIR using the provided env", () => {
    const env = {
      HOME: "/tmp/openclaw-home",
      OPENCLAW_STATE_DIR: "~/state",
    } as NodeJS.ProcessEnv;

    expect(resolveConfigDir(env)).toBe(path.resolve("/tmp/openclaw-home", "state"));
  });

  it("falls back to the config file directory when only OPENCLAW_CONFIG_PATH is set", () => {
    const env = {
      HOME: "/tmp/openclaw-home",
      OPENCLAW_CONFIG_PATH: "~/profiles/dev/openclaw.json",
    } as NodeJS.ProcessEnv;

    expect(resolveConfigDir(env)).toBe(path.resolve("/tmp/openclaw-home", "profiles", "dev"));
  });

  it("re-pins the exported configuration root after startup environment selection", () => {
    const originalConfigDir = CONFIG_DIR;
    const selectedConfigDir = path.resolve("/tmp/openclaw-selected-config-root");
    try {
      expect(
        pinConfigDir({
          OPENCLAW_STATE_DIR: selectedConfigDir,
          OPENCLAW_TEST_FAST: "1",
        }),
      ).toBe(selectedConfigDir);
      expect(CONFIG_DIR).toBe(selectedConfigDir);
    } finally {
      pinConfigDir({
        OPENCLAW_STATE_DIR: originalConfigDir,
        OPENCLAW_TEST_FAST: "1",
      });
    }
  });
});

describe("resolveHomeDir", () => {
  it("prefers OPENCLAW_HOME over HOME", () => {
    withEnv({ OPENCLAW_HOME: "/srv/openclaw-home", HOME: "/home/other" }, () => {
      expect(resolveHomeDir()).toBe(path.resolve("/srv/openclaw-home"));
    });
  });
});

describe("shortenHomePath", () => {
  it("uses $OPENCLAW_HOME prefix when OPENCLAW_HOME is set", () => {
    withEnv({ OPENCLAW_HOME: "/srv/openclaw-home", HOME: "/home/other" }, () => {
      expect(shortenHomePath(`${path.resolve("/srv/openclaw-home")}/.openclaw/openclaw.json`)).toBe(
        "$OPENCLAW_HOME/.openclaw/openclaw.json",
      );
    });
  });
});

describe("shortenHomeInString", () => {
  it("uses $OPENCLAW_HOME replacement when OPENCLAW_HOME is set", () => {
    withEnv({ OPENCLAW_HOME: "/srv/openclaw-home", HOME: "/home/other" }, () => {
      expect(
        shortenHomeInString(
          `config: ${path.resolve("/srv/openclaw-home")}/.openclaw/openclaw.json`,
        ),
      ).toBe("config: $OPENCLAW_HOME/.openclaw/openclaw.json");
    });
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
    withEnv({ OPENCLAW_HOME: "/srv/openclaw-home", HOME: "/home/other" }, () => {
      expect(resolveUserPath("~/openclaw")).toBe(path.resolve("/srv/openclaw-home", "openclaw"));
    });
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
