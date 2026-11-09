import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, test } from "vitest";
import {
  applyOpenClawManifestInstallCommonFields,
  parseFrontmatterBool,
  parseOpenClawManifestInstallBase,
  resolveOpenClawManifestBlock,
  resolveOpenClawManifestInstall,
  resolveOpenClawManifestOs,
  resolveOpenClawManifestRequires,
} from "./frontmatter.js";

describe("shared/frontmatter", () => {
  test("parseFrontmatterBool respects explicit values and fallback", () => {
    expect(parseFrontmatterBool("true", false)).toBe(true);
    expect(parseFrontmatterBool("false", true)).toBe(false);
    expect(parseFrontmatterBool(undefined, true)).toBe(true);
    expect(parseFrontmatterBool("maybe", false)).toBe(false);
  });

  test("resolveOpenClawManifestBlock returns undefined for invalid input", () => {
    expect(resolveOpenClawManifestBlock({ frontmatter: {} })).toBeUndefined();
    expect(
      resolveOpenClawManifestBlock({ frontmatter: { metadata: "not-json5" } }),
    ).toBeUndefined();
    expect(resolveOpenClawManifestBlock({ frontmatter: { metadata: "123" } })).toBeUndefined();
    expect(resolveOpenClawManifestBlock({ frontmatter: { metadata: "[]" } })).toBeUndefined();
    expect(
      resolveOpenClawManifestBlock({ frontmatter: { metadata: "{ nope: { a: 1 } }" } }),
    ).toBeUndefined();
  });

  it("normalizes manifest requirement and os lists", () => {
    expect(
      resolveOpenClawManifestRequires({
        requires: {
          bins: "bun, node",
          anyBins: [" ffmpeg ", ""],
          env: ["OPENCLAW_TOKEN", " OPENCLAW_URL "],
          config: null,
        },
      }),
    ).toEqual({
      bins: ["bun", "node"],
      anyBins: ["ffmpeg"],
      env: ["OPENCLAW_TOKEN", "OPENCLAW_URL"],
      config: [],
    });
    expect(resolveOpenClawManifestRequires({})).toBeUndefined();
    expect(resolveOpenClawManifestOs({ os: [" darwin ", "linux", ""] })).toEqual([
      "darwin",
      "linux",
    ]);
  });

  it("parses and applies install common fields", () => {
    const raw = { type: " Brew ", id: "brew.git", label: "Git", bins: [" git ", "git"] };
    const expectedRaw = structuredClone(raw);
    const parsed = parseOpenClawManifestInstallBase(raw, ["brew", "npm"]);
    const common = { id: "brew.git", label: "Git", bins: ["git", "git"] };
    expect(parsed).toEqual({ raw: expectedRaw, kind: "brew", ...common });
    expect(parseOpenClawManifestInstallBase({ kind: "bad" }, ["brew"])).toBeUndefined();
    expect(
      applyOpenClawManifestInstallCommonFields<{
        extra: boolean;
        id?: string;
        label?: string;
        bins?: string[];
      }>({ extra: true }, expectDefined(parsed, "manifest install base")),
    ).toEqual({ extra: true, ...common });
  });

  it("prefers explicit kind, ignores invalid common fields, and leaves missing ones untouched", () => {
    const raw = { kind: " npm ", type: "brew", id: 42, label: null, bins: [" ", ""] };
    const expectedRaw = structuredClone(raw);
    const parsed = parseOpenClawManifestInstallBase(raw, ["brew", "npm"]);
    expect(parsed).toEqual({ raw: expectedRaw, kind: "npm" });
    expect(
      applyOpenClawManifestInstallCommonFields(
        { id: "keep", label: "Keep", bins: ["bun"] },
        parsed!,
      ),
    ).toEqual({ id: "keep", label: "Keep", bins: ["bun"] });
  });

  it("maps install entries through the parser and filters rejected specs", () => {
    const keep = { id: "keep" };
    expect(
      resolveOpenClawManifestInstall({ install: [keep, { id: "drop" }, "bad"] }, (entry) =>
        entry === keep ? { id: "keep" } : undefined,
      ),
    ).toEqual([{ id: "keep" }]);
  });
});
