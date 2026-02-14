/**
 * Integration tests for the secure hook loader.
 *
 * These tests verify that legitimate hooks can still be loaded
 * after the security fixes are applied.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("Hook Loader Integration", () => {
  let tempDir: string;
  let workspaceDir: string;
  let hooksDir: string;
  let testHookDir: string;

  beforeAll(() => {
    // Create temporary workspace
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-integration-test-"));
    workspaceDir = path.join(tempDir, "workspace");
    hooksDir = path.join(workspaceDir, "hooks");
    testHookDir = path.join(hooksDir, "test-hook");

    fs.mkdirSync(testHookDir, { recursive: true });

    // Create a valid hook
    const hookMd = path.join(testHookDir, "HOOK.md");
    const hookHandler = path.join(testHookDir, "handler.js");

    fs.writeFileSync(
      hookMd,
      `---
name: test-hook
description: A test hook for integration testing
events: 
  - command:test
---

# Test Hook

This is a test hook used for integration testing.
`,
    );

    fs.writeFileSync(
      hookHandler,
      `export default async function testHook(event) {
  console.log('Test hook executed:', event.type);
  return { success: true };
}`,
    );
  });

  afterAll(() => {
    // Cleanup
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Legitimate Hook Loading", () => {
    it("should load valid hooks from workspace directory", async () => {
      // This test verifies that our security fixes don't break legitimate hook loading
      // We can't easily test the full loadInternalHooks function without more setup,
      // but we can test the individual components

      const { validateModulePath } = await import("../security.js");
      const handlerPath = path.join(testHookDir, "handler.js");

      const result = validateModulePath(handlerPath, {
        allowedBaseDirs: [hooksDir],
      });

      expect(result.valid).toBe(true);
      if (result.valid) {
        // The path should be the resolved handler path
        expect(result.path).toBe(fs.realpathSync(handlerPath));
      }
    });

    it("should reject hooks from outside workspace", async () => {
      const { validateModulePath } = await import("../security.js");

      // Create a malicious hook outside the workspace
      const maliciousDir = path.join(tempDir, "malicious");
      fs.mkdirSync(maliciousDir, { recursive: true });
      const maliciousHandler = path.join(maliciousDir, "evil.js");
      fs.writeFileSync(maliciousHandler, "console.log('pwned');");

      const result = validateModulePath(maliciousHandler, {
        allowedBaseDirs: [hooksDir],
      });

      expect(result.valid).toBe(false);

      fs.rmSync(maliciousDir, { recursive: true });
    });

    it("should validate multiple allowed directories correctly", async () => {
      const { validateModulePath } = await import("../security.js");

      // Create a second allowed directory
      const secondDir = path.join(tempDir, "managed-hooks");
      fs.mkdirSync(secondDir, { recursive: true });
      const managedHandler = path.join(secondDir, "managed.js");
      fs.writeFileSync(managedHandler, "export default function() {}");

      const result = validateModulePath(managedHandler, {
        allowedBaseDirs: [hooksDir, secondDir],
      });

      expect(result.valid).toBe(true);

      fs.rmSync(secondDir, { recursive: true });
    });
  });

  describe("Security Boundary Enforcement", () => {
    it("should prevent path traversal even with crafted hook names", async () => {
      const { validateModulePath } = await import("../security.js");

      // Simulate a path that might come from a malicious hook directory name
      const traversalPath = path.join(hooksDir, "../../../etc/passwd");

      const result = validateModulePath(traversalPath, {
        allowedBaseDirs: [hooksDir],
      });

      expect(result.valid).toBe(false);
    });

    it("should enforce extension restrictions", async () => {
      const { validateModulePath } = await import("../security.js");

      // Create a file with a disallowed extension
      const badExtension = path.join(testHookDir, "evil.sh");
      fs.writeFileSync(badExtension, "#!/bin/bash\necho 'evil script'");

      const result = validateModulePath(badExtension, {
        allowedBaseDirs: [hooksDir],
      });

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe("INVALID_EXTENSION");
      }

      fs.unlinkSync(badExtension);
    });
  });
});
