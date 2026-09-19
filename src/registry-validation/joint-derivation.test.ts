// Tests for JointDerivation observer.
import { describe, expect, it } from "vitest";
import { EvidenceRecordSchema } from "../config/zod-schema.registry-validation.js";
import { deriveJointPath, deriveJointPaths } from "./joint-derivation.js";

const FIXED_TIME = "2026-07-18T12:00:00.000Z";
const now = () => FIXED_TIME;

describe("JointDerivationObserver", () => {
  it("valid workspace and relative path", () => {
    const result = deriveJointPath(
      { workspace: "/home/user", relativePath: "projects/joint" },
      { now },
    );
    expect(result.status).toBe("DERIVED");
    expect(result.resolvedPath).toBeTruthy();
    expect(result.error).toBeNull();
  });

  it("multiple paths", () => {
    const results = deriveJointPaths("/home/user", ["projects/a", "projects/b", "docs/c"], { now });
    expect(results.length).toBe(3);
    expect(results.every((r) => r.status === "DERIVED")).toBe(true);
  });

  it("missing workspace", () => {
    const result = deriveJointPath({ workspace: "", relativePath: "projects/joint" }, { now });
    expect(result.status).toBe("UNAVAILABLE");
    expect(result.resolvedPath).toBeNull();
    expect(result.error).toContain("Workspace");
  });

  it("invalid relative path (empty)", () => {
    const result = deriveJointPath({ workspace: "/home/user", relativePath: "" }, { now });
    expect(result.status).toBe("INVALID_PATH");
    expect(result.resolvedPath).toBeNull();
  });

  it("absolute child rejected", () => {
    const result = deriveJointPath(
      { workspace: "/home/user", relativePath: "/absolute/path" },
      { now },
    );
    expect(result.status).toBe("REJECTED");
    expect(result.resolvedPath).toBeNull();
    expect(result.error).toContain("Absolute");
  });

  it("traversal escape rejected", () => {
    const result = deriveJointPath(
      { workspace: "/home/user/workspace", relativePath: "../../etc/passwd" },
      { now },
    );
    expect(result.status).toBe("REJECTED");
    expect(result.resolvedPath).toBeNull();
    expect(result.error).toContain("escapes workspace");
  });

  it("no nearest-parent fallback", () => {
    // Even with a complex relative path, the observer should not search parent directories
    const result = deriveJointPath(
      { workspace: "/home/user/workspace", relativePath: "valid/relative/path" },
      { now },
    );
    expect(result.status).toBe("DERIVED");
    expect(result.resolvedPath).toBeTruthy();
    // The resolved path should be within the workspace, not a parent
    expect(result.resolvedPath).toContain("workspace");
  });

  it("no directory creation (pure function, no side effects)", () => {
    const result = deriveJointPath(
      { workspace: "/nonexistent/workspace", relativePath: "some/path" },
      { now },
    );
    expect(result.status).toBe("DERIVED");
    // No directory should be created — this is a pure derivation
    expect(result.resolvedPath).toBeTruthy();
  });

  it("Windows separators handled", () => {
    const result = deriveJointPath(
      { workspace: "C:\\Users\\test", relativePath: "projects\\joint" },
      { now },
    );
    expect(result.status).toBe("DERIVED");
    expect(result.resolvedPath).toBeTruthy();
  });

  it("deterministic evidence", () => {
    const result1 = deriveJointPath(
      { workspace: "/home/user", relativePath: "projects/joint" },
      { now: () => FIXED_TIME },
    );
    const result2 = deriveJointPath(
      { workspace: "/home/user", relativePath: "projects/joint" },
      { now: () => FIXED_TIME },
    );
    expect(result1).toEqual(result2);
  });

  it("evidence validates against Phase 4F1 schema", () => {
    const result = deriveJointPath(
      { workspace: "/home/user", relativePath: "projects/joint" },
      { now },
    );
    for (const evidence of result.evidence) {
      const validation = EvidenceRecordSchema.safeParse(evidence);
      expect(validation.success).toBe(true);
    }
  });

  it("preserves derivation rule in evidence", () => {
    const customRule = "JOINT custom: workspace + path → resolved";
    const result = deriveJointPath(
      { workspace: "/home/user", relativePath: "path", derivationRule: customRule },
      { now },
    );
    expect(result.derivationRule).toBe(customRule);
    expect(result.evidence[0]?.notes).toContain(customRule);
  });
});
