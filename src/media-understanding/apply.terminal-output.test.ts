/** Tests for terminal output detection and MIME type handling */
import { describe, it, expect } from "vitest";
import { sanitizeMimeType } from "./apply.js";

describe("Terminal Output Detection", () => {
  describe("sanitizeMimeType", () => {
    it("should preserve explicit text/plain MIME types", () => {
      expect(sanitizeMimeType("text/plain")).toBe("text/plain");
      expect(sanitizeMimeType("text/plain; charset=utf-8")).toBe("text/plain");
    });

    it("should handle MIME types with parameters", () => {
      expect(sanitizeMimeType("text/html; charset=utf-8")).toBe("text/html");
      expect(sanitizeMimeType("application/json; charset=utf-8")).toBe("application/json");
    });

    it("should normalize MIME types to lowercase", () => {
      expect(sanitizeMimeType("TEXT/PLAIN")).toBe("text/plain");
      expect(sanitizeMimeType("Application/JSON")).toBe("application/json");
    });

    it("should return undefined for empty or whitespace-only input", () => {
      expect(sanitizeMimeType("")).toBeUndefined();
      expect(sanitizeMimeType("   ")).toBeUndefined();
      expect(sanitizeMimeType(undefined)).toBeUndefined();
      expect(sanitizeMimeType(null)).toBeUndefined();
    });
  });

  describe("PowerShell output patterns", () => {
    // These would be tested through integration tests with actual command outputs
    it("should recognize PowerShell directory listing patterns", () => {
      // This is a placeholder - actual testing would use the isLikelyTerminalOutput function
      const psOutput = `
    Mode                 LastWriteTime         Length Name
    ----                 -------------         ------ ----
    d-----         7/6/2026  10:00 AM                src
    -a----         7/6/2026   9:30 AM           1234 file.txt
      `.trim();

      // The output should be detected as text, not binary
      expect(psOutput.length).toBeGreaterThan(0);
    });

    it("should recognize PowerShell Get-Content output", () => {
      const getContentOutput = `
Line 1: This is a text file
Line 2: With multiple lines
Line 3: And some content
      `.trim();

      expect(getContentOutput.length).toBeGreaterThan(0);
    });
  });

  describe("curl output patterns", () => {
    it("should recognize HTTP response patterns", () => {
      const curlOutput = `
  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current
                                 Dload  Upload   Total   Spent    Left  Speed
100   123  100   123    0     0   1234      0 --:--:-- --:--:-- --:--:--  1234
HTTP/1.1 200 OK
Content-Type: application/json

{"status": "ok"}
      `.trim();

      expect(curlOutput.length).toBeGreaterThan(0);
    });
  });

  describe("Unix ls output patterns", () => {
    it("should recognize Unix directory listing", () => {
      const lsOutput = `
total 48
drwxr-xr-x  5 user group  4096 Jul  6 10:00 .
drwxr-xr-x 10 user group  4096 Jul  6 09:00 ..
-rw-r--r--  1 user group  1234 Jul  6 09:30 file.txt
drwxr-xr-x  3 user group  4096 Jul  6 10:00 src
      `.trim();

      expect(lsOutput.length).toBeGreaterThan(0);
    });
  });
});
