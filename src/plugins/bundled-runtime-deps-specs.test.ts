import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeInstallableRuntimeDepName,
  parseInstallableRuntimeDep,
  parseInstallableRuntimeDepSpec,
  resolveDependencySentinelAbsolutePath,
} from "./bundled-runtime-deps-specs.js";

describe("normalizeInstallableRuntimeDepName", () => {
  it("returns the name when it is a valid plain package", () => {
    expect(normalizeInstallableRuntimeDepName("plain")).toBe("plain");
    expect(normalizeInstallableRuntimeDepName("with-dash")).toBe("with-dash");
    expect(normalizeInstallableRuntimeDepName("with_under")).toBe("with_under");
    expect(normalizeInstallableRuntimeDepName("with.dot")).toBe("with.dot");
    expect(normalizeInstallableRuntimeDepName("alpha9")).toBe("alpha9");
  });

  it("returns the name when it is a valid scoped package", () => {
    expect(normalizeInstallableRuntimeDepName("@scope/pkg")).toBe("@scope/pkg");
    expect(normalizeInstallableRuntimeDepName("@scope/pkg-name")).toBe("@scope/pkg-name");
  });

  it("trims surrounding whitespace before validating", () => {
    expect(normalizeInstallableRuntimeDepName("  plain  ")).toBe("plain");
  });

  it("rejects empty, dotted, and traversal segments", () => {
    expect(normalizeInstallableRuntimeDepName("")).toBeNull();
    expect(normalizeInstallableRuntimeDepName("   ")).toBeNull();
    expect(normalizeInstallableRuntimeDepName("./plain")).toBeNull();
    expect(normalizeInstallableRuntimeDepName("../plain")).toBeNull();
    expect(normalizeInstallableRuntimeDepName("plain/.")).toBeNull();
    expect(normalizeInstallableRuntimeDepName("plain/..")).toBeNull();
    expect(normalizeInstallableRuntimeDepName("a/b/c")).toBeNull();
  });

  it("rejects invalid plain names", () => {
    expect(normalizeInstallableRuntimeDepName("Plain")).toBeNull();
    expect(normalizeInstallableRuntimeDepName("-plain")).toBeNull();
    expect(normalizeInstallableRuntimeDepName(".plain")).toBeNull();
  });

  it("rejects scoped names without the @ prefix", () => {
    expect(normalizeInstallableRuntimeDepName("scope/pkg")).toBeNull();
  });

  it("rejects scoped names with invalid scope or package segments", () => {
    expect(normalizeInstallableRuntimeDepName("@Scope/pkg")).toBeNull();
    expect(normalizeInstallableRuntimeDepName("@scope/Pkg")).toBeNull();
    expect(normalizeInstallableRuntimeDepName("@scope/-pkg")).toBeNull();
  });
});

describe("parseInstallableRuntimeDep", () => {
  it("parses a valid name with a plain semver", () => {
    expect(parseInstallableRuntimeDep("plain", "1.2.3")).toEqual({
      name: "plain",
      version: "1.2.3",
    });
  });

  it("accepts caret and tilde range prefixes", () => {
    expect(parseInstallableRuntimeDep("plain", "^1.2.3")).toEqual({
      name: "plain",
      version: "^1.2.3",
    });
    expect(parseInstallableRuntimeDep("plain", "~1.2.3")).toEqual({
      name: "plain",
      version: "~1.2.3",
    });
  });

  it("returns null for non-string version", () => {
    expect(parseInstallableRuntimeDep("plain", undefined)).toBeNull();
    expect(parseInstallableRuntimeDep("plain", 1)).toBeNull();
    expect(parseInstallableRuntimeDep("plain", null)).toBeNull();
  });

  it("returns null for empty or workspace-prefixed version", () => {
    expect(parseInstallableRuntimeDep("plain", "")).toBeNull();
    expect(parseInstallableRuntimeDep("plain", "   ")).toBeNull();
    expect(parseInstallableRuntimeDep("plain", "workspace:^1")).toBeNull();
    expect(parseInstallableRuntimeDep("plain", "WORKSPACE:^1")).toBeNull();
  });

  it("throws when the name cannot normalize", () => {
    expect(() => parseInstallableRuntimeDep("../bad", "1.0.0")).toThrow(
      /Invalid bundled runtime dependency name/,
    );
  });

  it("throws when the version is not a supported semver or range", () => {
    expect(() => parseInstallableRuntimeDep("plain", "not-a-version")).toThrow(
      /Unsupported bundled runtime dependency spec/,
    );
    expect(() => parseInstallableRuntimeDep("plain", ">=1.0.0")).toThrow(
      /Unsupported bundled runtime dependency spec/,
    );
  });
});

describe("parseInstallableRuntimeDepSpec", () => {
  it("parses a name@version spec", () => {
    expect(parseInstallableRuntimeDepSpec("plain@1.2.3")).toEqual({
      name: "plain",
      version: "1.2.3",
    });
  });

  it("uses the last @ to split scoped name@version specs", () => {
    expect(parseInstallableRuntimeDepSpec("@scope/pkg@1.2.3")).toEqual({
      name: "@scope/pkg",
      version: "1.2.3",
    });
  });

  it("accepts range prefixes on scoped specs", () => {
    expect(parseInstallableRuntimeDepSpec("@scope/pkg@^1.2.3")).toEqual({
      name: "@scope/pkg",
      version: "^1.2.3",
    });
  });

  it("throws when the spec lacks a separator", () => {
    expect(() => parseInstallableRuntimeDepSpec("plain")).toThrow(
      /Invalid bundled runtime dependency install spec/,
    );
  });

  it("throws when the spec ends with @", () => {
    expect(() => parseInstallableRuntimeDepSpec("plain@")).toThrow(
      /Invalid bundled runtime dependency install spec/,
    );
  });

  it("throws when a scoped spec has no version separator", () => {
    expect(() => parseInstallableRuntimeDepSpec("@scope/pkg")).toThrow(
      /Invalid bundled runtime dependency install spec/,
    );
  });

  it("throws when the version slice is workspace-prefixed", () => {
    expect(() => parseInstallableRuntimeDepSpec("plain@workspace:^1")).toThrow(
      /Invalid bundled runtime dependency install spec/,
    );
  });
});

describe("resolveDependencySentinelAbsolutePath", () => {
  const rootDir = path.join(os.tmpdir(), "openclaw-runtime-deps-specs-test");

  it("resolves a plain package sentinel under node_modules", () => {
    expect(resolveDependencySentinelAbsolutePath(rootDir, "plain")).toBe(
      path.join(rootDir, "node_modules", "plain", "package.json"),
    );
  });

  it("resolves a scoped package sentinel under node_modules/@scope/pkg", () => {
    expect(resolveDependencySentinelAbsolutePath(rootDir, "@scope/pkg")).toBe(
      path.join(rootDir, "node_modules", "@scope", "pkg", "package.json"),
    );
  });

  it("throws on an invalid dependency name before resolving", () => {
    expect(() => resolveDependencySentinelAbsolutePath(rootDir, "../escape")).toThrow(
      /Invalid bundled runtime dependency name/,
    );
  });
});
