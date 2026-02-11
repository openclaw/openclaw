import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertWebChannel,
  CONFIG_DIR,
  containsUrls,
  detectUrls,
  ensureDir,
  jidToE164,
  mangleUrlsForPreview,
  normalizeE164,
  normalizePath,
  resolveConfigDir,
  resolveHomeDir,
  resolveJidToE164,
  resolveUserPath,
  shortenHomeInString,
  shortenHomePath,
  sleep,
  toWhatsappJid,
  withWhatsAppPrefix,
} from "./utils.js";

describe("normalizePath", () => {
  it("adds leading slash when missing", () => {
    expect(normalizePath("foo")).toBe("/foo");
  });

  it("keeps existing slash", () => {
    expect(normalizePath("/bar")).toBe("/bar");
  });
});

describe("withWhatsAppPrefix", () => {
  it("adds whatsapp prefix", () => {
    expect(withWhatsAppPrefix("+1555")).toBe("whatsapp:+1555");
  });

  it("leaves prefixed intact", () => {
    expect(withWhatsAppPrefix("whatsapp:+1555")).toBe("whatsapp:+1555");
  });
});

describe("ensureDir", () => {
  it("creates nested directory", async () => {
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-test-"));
    const target = path.join(tmp, "nested", "dir");
    await ensureDir(target);
    expect(fs.existsSync(target)).toBe(true);
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

describe("assertWebChannel", () => {
  it("accepts valid channel", () => {
    expect(() => assertWebChannel("web")).not.toThrow();
  });

  it("throws for invalid channel", () => {
    expect(() => assertWebChannel("bad" as string)).toThrow();
  });
});

describe("normalizeE164 & toWhatsappJid", () => {
  it("strips formatting and prefixes", () => {
    expect(normalizeE164("whatsapp:(555) 123-4567")).toBe("+5551234567");
    expect(toWhatsappJid("whatsapp:+555 123 4567")).toBe("5551234567@s.whatsapp.net");
  });

  it("preserves existing JIDs", () => {
    expect(toWhatsappJid("123456789-987654321@g.us")).toBe("123456789-987654321@g.us");
    expect(toWhatsappJid("whatsapp:123456789-987654321@g.us")).toBe("123456789-987654321@g.us");
    expect(toWhatsappJid("1555123@s.whatsapp.net")).toBe("1555123@s.whatsapp.net");
  });
});

describe("jidToE164", () => {
  it("maps @lid using reverse mapping file", () => {
    const mappingPath = path.join(CONFIG_DIR, "credentials", "lid-mapping-123_reverse.json");
    const original = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation((...args) => {
      if (args[0] === mappingPath) {
        return `"5551234"`;
      }
      return original(...args);
    });
    expect(jidToE164("123@lid")).toBe("+5551234");
    spy.mockRestore();
  });

  it("maps @lid from authDir mapping files", () => {
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    const mappingPath = path.join(authDir, "lid-mapping-456_reverse.json");
    fs.writeFileSync(mappingPath, JSON.stringify("5559876"));
    expect(jidToE164("456@lid", { authDir })).toBe("+5559876");
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  it("maps @hosted.lid from authDir mapping files", () => {
    const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-auth-"));
    const mappingPath = path.join(authDir, "lid-mapping-789_reverse.json");
    fs.writeFileSync(mappingPath, JSON.stringify(4440001));
    expect(jidToE164("789@hosted.lid", { authDir })).toBe("+4440001");
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  it("accepts hosted PN JIDs", () => {
    expect(jidToE164("1555000:2@hosted")).toBe("+1555000");
  });

  it("falls back through lidMappingDirs in order", () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lid-a-"));
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lid-b-"));
    const mappingPath = path.join(second, "lid-mapping-321_reverse.json");
    fs.writeFileSync(mappingPath, JSON.stringify("123321"));
    expect(jidToE164("321@lid", { lidMappingDirs: [first, second] })).toBe("+123321");
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
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

describe("resolveJidToE164", () => {
  it("resolves @lid via lidLookup when mapping file is missing", async () => {
    const lidLookup = {
      getPNForLID: vi.fn().mockResolvedValue("777:0@s.whatsapp.net"),
    };
    await expect(resolveJidToE164("777@lid", { lidLookup })).resolves.toBe("+777");
    expect(lidLookup.getPNForLID).toHaveBeenCalledWith("777@lid");
  });

  it("skips lidLookup for non-lid JIDs", async () => {
    const lidLookup = {
      getPNForLID: vi.fn().mockResolvedValue("888:0@s.whatsapp.net"),
    };
    await expect(resolveJidToE164("888@s.whatsapp.net", { lidLookup })).resolves.toBe("+888");
    expect(lidLookup.getPNForLID).not.toHaveBeenCalled();
  });
});

describe("resolveUserPath", () => {
  it("expands ~ to home dir", () => {
    expect(resolveUserPath("~")).toBe(path.resolve(os.homedir()));
  });

  it("expands ~/ to home dir", () => {
    expect(resolveUserPath("~/openclaw")).toBe(path.resolve(os.homedir(), "openclaw"));
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

  it("keeps blank paths blank", () => {
    expect(resolveUserPath("")).toBe("");
    expect(resolveUserPath("   ")).toBe("");
  });
});

describe("URL detection utilities", () => {
  describe("detectUrls", () => {
    it("detects http URLs", () => {
      expect(detectUrls("Check http://example.com for info")).toEqual(["http://example.com"]);
    });

    it("detects https URLs", () => {
      expect(detectUrls("Visit https://example.com/path?q=1")).toEqual([
        "https://example.com/path?q=1",
      ]);
    });

    it("detects multiple URLs", () => {
      const text = "See https://a.com and https://b.com/path";
      expect(detectUrls(text)).toEqual(["https://a.com", "https://b.com/path"]);
    });

    it("returns empty array when no URLs", () => {
      expect(detectUrls("No links here")).toEqual([]);
    });

    it("handles URLs with various characters", () => {
      expect(detectUrls("https://example.com/path/to/page#section")).toEqual([
        "https://example.com/path/to/page#section",
      ]);
    });
  });

  describe("containsUrls", () => {
    it("returns true when URLs present", () => {
      expect(containsUrls("Check https://example.com")).toBe(true);
    });

    it("returns false when no URLs", () => {
      expect(containsUrls("No links here")).toBe(false);
    });

    it("works correctly on repeated calls (no global regex lastIndex bug)", () => {
      // This tests the fix for the stateful regex bug where global regex
      // with .test() mutates lastIndex and can return false on repeated calls
      const text = "Visit https://example.com today";
      expect(containsUrls(text)).toBe(true);
      expect(containsUrls(text)).toBe(true);
      expect(containsUrls(text)).toBe(true);

      // Also verify it works after detectUrls/mangleUrlsForPreview calls
      detectUrls(text);
      expect(containsUrls(text)).toBe(true);
      mangleUrlsForPreview(text);
      expect(containsUrls(text)).toBe(true);
    });
  });

  describe("mangleUrlsForPreview", () => {
    it("wraps URLs in angle brackets", () => {
      expect(mangleUrlsForPreview("Visit https://example.com today")).toBe(
        "Visit <https://example.com> today",
      );
    });

    it("handles multiple URLs", () => {
      expect(mangleUrlsForPreview("See https://a.com and https://b.com")).toBe(
        "See <https://a.com> and <https://b.com>",
      );
    });

    it("preserves text without URLs", () => {
      expect(mangleUrlsForPreview("No links here")).toBe("No links here");
    });

    it("does not double-wrap already wrapped URLs", () => {
      expect(mangleUrlsForPreview("Already <https://example.com> wrapped")).toBe(
        "Already <https://example.com> wrapped",
      );
    });
  });
});
