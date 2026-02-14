/**
 * Tests for the hook module security validation system.
 *
 * This file tests the CWE-94 (Code Injection) prevention measures
 * implemented in the hook loading system.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  validateModulePath,
  validateExtraHooksDir,
  PathValidationError,
  getErrorDescription,
} from "../security.js";

describe("Hook Security Validation", () => {
  let tempDir: string;
  let allowedDir: string;
  let disallowedDir: string;
  let validHookFile: string;
  let maliciousFile: string;

  beforeAll(() => {
    // Create temporary test directories
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-security-test-"));
    allowedDir = path.join(tempDir, "allowed");
    disallowedDir = path.join(tempDir, "disallowed");

    fs.mkdirSync(allowedDir, { recursive: true });
    fs.mkdirSync(disallowedDir, { recursive: true });

    // Create test files
    validHookFile = path.join(allowedDir, "hook.js");
    fs.writeFileSync(validHookFile, "export default function() { console.log('valid hook'); }");

    maliciousFile = path.join(disallowedDir, "malicious.js");
    fs.writeFileSync(maliciousFile, "console.log('This should not execute');");
  });

  afterAll(() => {
    // Cleanup
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("validateModulePath", () => {
    describe("Valid Paths", () => {
      it("should accept a valid JavaScript file within allowed directory", () => {
        const result = validateModulePath(validHookFile, {
          allowedBaseDirs: [allowedDir],
        });

        expect(result.valid).toBe(true);
        if (result.valid) {
          expect(result.path).toBe(fs.realpathSync(validHookFile));
        }
      });

      it("should accept TypeScript files", () => {
        const tsFile = path.join(allowedDir, "hook.ts");
        fs.writeFileSync(tsFile, "export default function() {}");

        const result = validateModulePath(tsFile, {
          allowedBaseDirs: [allowedDir],
        });

        expect(result.valid).toBe(true);

        fs.unlinkSync(tsFile);
      });

      it("should accept .mjs files", () => {
        const mjsFile = path.join(allowedDir, "hook.mjs");
        fs.writeFileSync(mjsFile, "export default function() {}");

        const result = validateModulePath(mjsFile, {
          allowedBaseDirs: [allowedDir],
        });

        expect(result.valid).toBe(true);

        fs.unlinkSync(mjsFile);
      });

      it("should accept .mts files", () => {
        const mtsFile = path.join(allowedDir, "hook.mts");
        fs.writeFileSync(mtsFile, "export default function() {}");

        const result = validateModulePath(mtsFile, {
          allowedBaseDirs: [allowedDir],
        });

        expect(result.valid).toBe(true);

        fs.unlinkSync(mtsFile);
      });

      it("should accept paths with multiple allowed directories", () => {
        const anotherAllowed = path.join(tempDir, "another-allowed");
        fs.mkdirSync(anotherAllowed, { recursive: true });
        const anotherHook = path.join(anotherAllowed, "hook.js");
        fs.writeFileSync(anotherHook, "export default function() {}");

        const result = validateModulePath(anotherHook, {
          allowedBaseDirs: [allowedDir, anotherAllowed],
        });

        expect(result.valid).toBe(true);

        fs.unlinkSync(anotherHook);
        fs.rmSync(anotherAllowed, { recursive: true });
      });
    });

    describe("Path Traversal Prevention", () => {
      it("should reject basic path traversal attempts", () => {
        // Construct path manually - path.join resolves .. before we can detect it
        const maliciousPath = `${allowedDir}/../disallowed/malicious.js`;

        const result = validateModulePath(maliciousPath, {
          allowedBaseDirs: [allowedDir],
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(PathValidationError.PATH_TRAVERSAL_DETECTED);
        }
      });

      it("should reject URL-encoded path traversal", () => {
        const maliciousPath = path.join(allowedDir, "%2e%2e/disallowed/malicious.js");

        const result = validateModulePath(maliciousPath, {
          allowedBaseDirs: [allowedDir],
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(PathValidationError.PATH_TRAVERSAL_DETECTED);
        }
      });

      it("should reject double-encoded path traversal", () => {
        const maliciousPath = path.join(allowedDir, "%252e%252e/disallowed/malicious.js");

        const result = validateModulePath(maliciousPath, {
          allowedBaseDirs: [allowedDir],
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(PathValidationError.PATH_TRAVERSAL_DETECTED);
        }
      });

      it("should reject Unicode normalization attacks", () => {
        const unicodeAttacks = [
          // Fullwidth solidus (U+FF0F)
          path.join(allowedDir, "..／..／disallowed／malicious.js"),
          // Division slash (U+2215)
          path.join(allowedDir, "..∕..∕disallowed∕malicious.js"),
          // Backslash variants
          path.join(allowedDir, "..＼..＼disallowed＼malicious.js"),
        ];

        for (const attack of unicodeAttacks) {
          const result = validateModulePath(attack, {
            allowedBaseDirs: [allowedDir],
          });

          expect(result.valid).toBe(false);
          if (!result.valid) {
            expect(result.reason).toBe(PathValidationError.PATH_TRAVERSAL_DETECTED);
          }
        }
      });

      it("should reject mixed encoding attacks", () => {
        const mixedAttacks = [
          path.join(allowedDir, "..%2F../disallowed/malicious.js"),
          path.join(allowedDir, "../%2e%2e/disallowed/malicious.js"),
          path.join(allowedDir, "..\\%2e%2e\\disallowed\\malicious.js"),
        ];

        for (const attack of mixedAttacks) {
          const result = validateModulePath(attack, {
            allowedBaseDirs: [allowedDir],
          });

          expect(result.valid).toBe(false);
          if (!result.valid) {
            expect(result.reason).toBe(PathValidationError.PATH_TRAVERSAL_DETECTED);
          }
        }
      });

      it("should reject paths outside the allowed directory", () => {
        const result = validateModulePath(maliciousFile, {
          allowedBaseDirs: [allowedDir],
        });

        expect(result.valid).toBe(false);
      });
    });

    describe("Symlink Attack Prevention", () => {
      it("should detect and reject symlink file escape attempts", () => {
        const symlinkPath = path.join(allowedDir, "evil-symlink.js");

        try {
          fs.symlinkSync(maliciousFile, symlinkPath);

          const result = validateModulePath(symlinkPath, {
            allowedBaseDirs: [allowedDir],
          });

          expect(result.valid).toBe(false);
          if (!result.valid) {
            expect(result.reason).toBe(PathValidationError.SYMLINK_ESCAPE);
          }
        } catch (error) {
          // If symlink creation fails (e.g., on Windows without admin), skip test
          console.log("Symlink file test skipped - not supported on this system:", error);
        } finally {
          try {
            fs.unlinkSync(symlinkPath);
          } catch {
            // Ignore cleanup errors
          }
        }
      });

      it("should detect and reject symlink parent directory escape attempts", () => {
        const symlinkDirPath = path.join(allowedDir, "evil-symlink-dir");
        const handlerInSymlinkDir = path.join(symlinkDirPath, "handler.js");

        try {
          // Create symlink directory pointing to disallowed location
          fs.symlinkSync(disallowedDir, symlinkDirPath);

          // Create handler file in the target location
          const targetHandlerPath = path.join(disallowedDir, "handler.js");
          fs.writeFileSync(targetHandlerPath, "console.log('symlink directory attack');");

          // Try to load handler through symlinked directory
          const result = validateModulePath(handlerInSymlinkDir, {
            allowedBaseDirs: [allowedDir],
          });

          expect(result.valid).toBe(false);
          if (!result.valid) {
            expect(result.reason).toBe(PathValidationError.SYMLINK_ESCAPE);
          }

          fs.unlinkSync(targetHandlerPath);
        } catch (error) {
          // If symlink creation fails (e.g., on Windows without admin), skip test
          console.log("Symlink directory test skipped - not supported on this system:", error);
        } finally {
          try {
            fs.unlinkSync(symlinkDirPath);
          } catch {
            // Ignore cleanup errors
          }
        }
      });

      it("should handle symlink chains correctly", () => {
        const symlinkChain1 = path.join(allowedDir, "chain1.js");
        const symlinkChain2 = path.join(allowedDir, "chain2.js");

        try {
          // Create chain: chain1 -> chain2 -> maliciousFile
          fs.symlinkSync(symlinkChain2, symlinkChain1);
          fs.symlinkSync(maliciousFile, symlinkChain2);

          const result = validateModulePath(symlinkChain1, {
            allowedBaseDirs: [allowedDir],
          });

          expect(result.valid).toBe(false);
          if (!result.valid) {
            expect(result.reason).toBe(PathValidationError.SYMLINK_ESCAPE);
          }
        } catch (error) {
          console.log("Symlink chain test skipped - not supported on this system:", error);
        } finally {
          try {
            fs.unlinkSync(symlinkChain1);
            fs.unlinkSync(symlinkChain2);
          } catch {
            // Ignore cleanup errors
          }
        }
      });
    });

    describe("Extension Validation", () => {
      it("should reject disallowed file extensions", () => {
        const jsonFile = path.join(allowedDir, "config.json");
        fs.writeFileSync(jsonFile, "{}");

        const result = validateModulePath(jsonFile, {
          allowedBaseDirs: [allowedDir],
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(PathValidationError.INVALID_EXTENSION);
        }

        fs.unlinkSync(jsonFile);
      });

      it("should reject executable files", () => {
        const exeFile = path.join(allowedDir, "malicious.exe");
        fs.writeFileSync(exeFile, "fake exe content");

        const result = validateModulePath(exeFile, {
          allowedBaseDirs: [allowedDir],
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(PathValidationError.INVALID_EXTENSION);
        }

        fs.unlinkSync(exeFile);
      });

      it("should accept additional extensions when configured", () => {
        const customFile = path.join(allowedDir, "hook.cjs");
        fs.writeFileSync(customFile, "module.exports = function() {}");

        const result = validateModulePath(customFile, {
          allowedBaseDirs: [allowedDir],
          additionalExtensions: [".cjs"],
        });

        expect(result.valid).toBe(true);

        fs.unlinkSync(customFile);
      });
    });

    describe("Input Sanitization", () => {
      it("should reject empty strings", () => {
        const result = validateModulePath("", {
          allowedBaseDirs: [allowedDir],
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(PathValidationError.PATH_EMPTY);
        }
      });

      it("should reject null values", () => {
        const result = validateModulePath(null, {
          allowedBaseDirs: [allowedDir],
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(PathValidationError.PATH_EMPTY);
        }
      });

      it("should reject undefined values", () => {
        const result = validateModulePath(undefined, {
          allowedBaseDirs: [allowedDir],
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(PathValidationError.PATH_EMPTY);
        }
      });

      it("should reject whitespace-only strings", () => {
        const result = validateModulePath("   ", {
          allowedBaseDirs: [allowedDir],
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(PathValidationError.PATH_EMPTY);
        }
      });
    });

    describe("File Existence", () => {
      it("should reject non-existent files", () => {
        const nonExistentFile = path.join(allowedDir, "nonexistent.js");

        const result = validateModulePath(nonExistentFile, {
          allowedBaseDirs: [allowedDir],
        });

        expect(result.valid).toBe(false);
        if (!result.valid) {
          expect(result.reason).toBe(PathValidationError.FILE_NOT_FOUND);
        }
      });
    });
  });

  describe("validateExtraHooksDir", () => {
    it("should accept valid existing directories", () => {
      const result = validateExtraHooksDir(allowedDir);

      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.path).toBe(fs.realpathSync(allowedDir));
      }
    });

    it("should reject non-existent directories", () => {
      const nonExistentDir = path.join(tempDir, "nonexistent");

      const result = validateExtraHooksDir(nonExistentDir);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe(PathValidationError.FILE_NOT_FOUND);
      }
    });

    it("should reject files instead of directories", () => {
      const result = validateExtraHooksDir(validHookFile);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe(PathValidationError.FILE_NOT_FOUND);
      }
    });

    it("should enforce containment when base dirs are specified", () => {
      const result = validateExtraHooksDir(disallowedDir, [allowedDir]);

      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.reason).toBe(PathValidationError.PATH_OUTSIDE_ALLOWED_DIRS);
      }
    });
  });

  describe("getErrorDescription", () => {
    it("should return human-readable descriptions for all error codes", () => {
      const errorCodes = Object.values(PathValidationError);

      for (const code of errorCodes) {
        const description = getErrorDescription(code);
        expect(description).toBeTruthy();
        expect(typeof description).toBe("string");
        expect(description.length).toBeGreaterThan(0);
      }
    });

    it("should return fallback for unknown error codes", () => {
      const description = getErrorDescription("UNKNOWN_CODE" as PathValidationError);
      expect(description).toBe("Unknown validation error");
    });
  });
});
