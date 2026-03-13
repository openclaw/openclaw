import { describe, expect, it } from "vitest";
import {
  normalizeStringList,
  getFrontmatterString,
  parseFrontmatterBool,
  resolveOpenClawManifestBlock,
  resolveOpenClawManifestRequires,
} from "./frontmatter.js";

describe("normalizeStringList", () => {
  it("returns empty array for null/undefined input", () => {
    expect(normalizeStringList(null)).toEqual([]);
    expect(normalizeStringList(undefined)).toEqual([]);
    expect(normalizeStringList("")).toEqual([]);
  });

  it("normalizes array input", () => {
    expect(normalizeStringList(["a", "b", "c"])).toEqual(["a", "b", "c"]);
    expect(normalizeStringList(["  a  ", "  b  "])).toEqual(["a", "b"]);
    expect(normalizeStringList(["a", "", "b", null, "c"])).toEqual(["a", "b", "c"]);
  });

  it("splits comma-separated string", () => {
    expect(normalizeStringList("a,b,c")).toEqual(["a", "b", "c"]);
    expect(normalizeStringList("  a  ,  b  ,  c  ")).toEqual(["a", "b", "c"]);
    expect(normalizeStringList("a,,b,,c")).toEqual(["a", "b", "c"]);
  });

  it("converts non-string/array to empty array", () => {
    expect(normalizeStringList(123)).toEqual([]);
    expect(normalizeStringList({})).toEqual([]);
    expect(normalizeStringList(true)).toEqual([]);
  });
});

describe("getFrontmatterString", () => {
  it("returns string value if present", () => {
    expect(getFrontmatterString({ title: "Hello" }, "title")).toBe("Hello");
    expect(getFrontmatterString({ name: "test" }, "name")).toBe("test");
  });

  it("returns undefined for non-string values", () => {
    expect(getFrontmatterString({ count: 123 }, "count")).toBeUndefined();
    expect(getFrontmatterString({ active: true }, "active")).toBeUndefined();
    expect(getFrontmatterString({ items: ["a", "b"] }, "items")).toBeUndefined();
  });

  it("returns undefined for missing keys", () => {
    expect(getFrontmatterString({}, "missing")).toBeUndefined();
    expect(getFrontmatterString({ other: "value" }, "key")).toBeUndefined();
  });
});

describe("parseFrontmatterBool", () => {
  it("parses true values", () => {
    expect(parseFrontmatterBool("true", false)).toBe(true);
    expect(parseFrontmatterBool("yes", false)).toBe(true);
    expect(parseFrontmatterBool("1", false)).toBe(true);
    expect(parseFrontmatterBool("on", false)).toBe(true);
  });

  it("parses false values", () => {
    expect(parseFrontmatterBool("false", true)).toBe(false);
    expect(parseFrontmatterBool("no", true)).toBe(false);
    expect(parseFrontmatterBool("0", true)).toBe(false);
    expect(parseFrontmatterBool("off", true)).toBe(false);
  });

  it("returns fallback for undefined/invalid values", () => {
    expect(parseFrontmatterBool(undefined, true)).toBe(true);
    expect(parseFrontmatterBool(undefined, false)).toBe(false);
    expect(parseFrontmatterBool("invalid", true)).toBe(true);
    expect(parseFrontmatterBool("maybe", false)).toBe(false);
  });
});

describe("resolveOpenClawManifestBlock", () => {
  it("returns undefined for missing metadata", () => {
    expect(resolveOpenClawManifestBlock({ frontmatter: {} })).toBeUndefined();
    expect(resolveOpenClawManifestBlock({ frontmatter: { other: "value" } })).toBeUndefined();
  });

  it("returns undefined for invalid JSON", () => {
    expect(resolveOpenClawManifestBlock({ frontmatter: { metadata: "invalid" } })).toBeUndefined();
    expect(resolveOpenClawManifestBlock({ frontmatter: { metadata: "{broken" } })).toBeUndefined();
  });

  it("extracts openclaw manifest from metadata", () => {
    const frontmatter = {
      metadata: '{"openclaw": {"requires": {"bins": ["git"]}}}',
    };
    const result = resolveOpenClawManifestBlock({ frontmatter });
    expect(result).toEqual({ requires: { bins: ["git"] } });
  });

  it("uses custom key when specified", () => {
    const frontmatter = {
      custom: '{"openclaw": {"version": "1.0"}}',
    };
    const result = resolveOpenClawManifestBlock({ frontmatter, key: "custom" });
    expect(result).toEqual({ version: "1.0" });
  });
});

describe("resolveOpenClawManifestRequires", () => {
  it("returns undefined for missing requires", () => {
    expect(resolveOpenClawManifestRequires({})).toBeUndefined();
    expect(resolveOpenClawManifestRequires({ name: "test" })).toBeUndefined();
  });

  it("normalizes bins list", () => {
    const result = resolveOpenClawManifestRequires({
      requires: { bins: ["git", "node", "npm"] },
    });
    expect(result?.bins).toEqual(["git", "node", "npm"]);
  });

  it("handles string bins input", () => {
    const result = resolveOpenClawManifestRequires({
      requires: { bins: "git,node" },
    });
    expect(result?.bins).toEqual(["git", "node"]);
  });

  it("normalizes env list", () => {
    const result = resolveOpenClawManifestRequires({
      requires: { env: ["HOME", "PATH"] },
    });
    expect(result?.env).toEqual(["HOME", "PATH"]);
  });

  it("normalizes config list", () => {
    const result = resolveOpenClawManifestRequires({
      requires: { config: ["apiKey", "endpoint"] },
    });
    expect(result?.config).toEqual(["apiKey", "endpoint"]);
  });
});
