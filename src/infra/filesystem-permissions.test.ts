import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  evaluateFilesystemPathPermission,
  normalizeFilesystemPermissionsConfig,
  resolveFilesystemPermissions,
} from "./filesystem-permissions.js";

describe("filesystem permissions", () => {
  it("uses most specific matching rule", () => {
    const permissions = resolveFilesystemPermissions({
      rules: {
        "/workspace/**": "r--",
        "/workspace/bin/**": "r-x",
      },
      default: "---",
    });
    expect(permissions).toBeDefined();
    const decision = evaluateFilesystemPathPermission({
      permissions: permissions!,
      targetPath: "/workspace/bin/tool",
      operation: "execute",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe("rule");
    expect(decision.sourcePattern).toBe("/workspace/bin/**");
  });

  it("applies deny patterns before rules", () => {
    const permissions = resolveFilesystemPermissions({
      rules: {
        "/workspace/**": "rwx",
      },
      deny: ["/workspace/secret/**"],
      default: "---",
    });
    expect(permissions).toBeDefined();
    const decision = evaluateFilesystemPathPermission({
      permissions: permissions!,
      targetPath: "/workspace/secret/private.txt",
      operation: "read",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("deny");
    expect(decision.sourcePattern).toBe("/workspace/secret/**");
  });

  it("falls back to default when no rule matches", () => {
    const permissions = resolveFilesystemPermissions({
      rules: {
        "/workspace/**": "rw-",
      },
      default: "r--",
    });
    expect(permissions).toBeDefined();
    const decision = evaluateFilesystemPathPermission({
      permissions: permissions!,
      targetPath: "/unmatched/file.txt",
      operation: "read",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.source).toBe("default");
    expect(decision.effectiveBits).toBe("r--");
  });

  it("normalizes malformed bits to safe defaults", () => {
    const normalized = normalizeFilesystemPermissionsConfig({
      rules: {
        "/workspace/**": "not-valid",
      },
      default: "bad",
    });
    expect(normalized?.rules?.["/workspace/**"]).toBe("---");
    expect(normalized?.default).toBeUndefined();
  });

  it("resolves relative targets using cwd", () => {
    const permissions = resolveFilesystemPermissions({
      rules: {
        "/workspace/**": "rw-",
      },
      default: "---",
    });
    expect(permissions).toBeDefined();
    const decision = evaluateFilesystemPathPermission({
      permissions: permissions!,
      targetPath: "./nested/file.txt",
      operation: "write",
      cwd: path.join(path.sep, "workspace"),
    });
    expect(decision.allowed).toBe(true);
    expect(decision.resolvedPath).toBe(path.join(path.sep, "workspace", "nested", "file.txt"));
  });
});
