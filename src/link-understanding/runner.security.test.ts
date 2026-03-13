import { describe, expect, it, vi, beforeEach } from "vitest";
import * as exec from "../process/exec.js";
import { runLinkUnderstanding } from "./runner.js";

vi.mock("../process/exec.js");

describe("CWE-78: Command Injection in link-understanding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(exec.runExec).mockResolvedValue({
      stdout: "mock output",
      stderr: "",
    });
  });

  const createTestConfig = (url: string) => ({
    cfg: {
      tools: {
        links: {
          enabled: true,
          models: [
            {
              command: "curl",
              args: ["{{LinkUrl}}"],
            },
          ],
        },
      },
    },
    ctx: {
      SessionKey: "test-session",
      Provider: "test",
      Body: url,
    },
    message: url,
  });

  it("should reject URLs with command substitution $()", async () => {
    const maliciousUrl = "https://example.com/page$(whoami)";
    const result = await runLinkUnderstanding(createTestConfig(maliciousUrl));

    // Should not execute with malicious URL
    expect(exec.runExec).not.toHaveBeenCalled();
    expect(result.urls).toEqual([]);
  });

  it("should reject URLs with backtick command substitution", async () => {
    const maliciousUrl = "https://example.com/page`id`";
    const result = await runLinkUnderstanding(createTestConfig(maliciousUrl));

    expect(exec.runExec).not.toHaveBeenCalled();
    expect(result.urls).toEqual([]);
  });

  it("should reject URLs with variable expansion", async () => {
    const maliciousUrl = "https://example.com/page${USER}";
    const result = await runLinkUnderstanding(createTestConfig(maliciousUrl));

    expect(exec.runExec).not.toHaveBeenCalled();
    expect(result.urls).toEqual([]);
  });

  it("should reject URLs with shell operators", async () => {
    const testCases = [
      "https://example.com/page;whoami",
      "https://example.com/page|nc",
      "https://example.com/page>output.txt",
      "https://example.com/page<input.txt",
    ];

    for (const maliciousUrl of testCases) {
      vi.clearAllMocks();
      const result = await runLinkUnderstanding(createTestConfig(maliciousUrl));

      expect(exec.runExec).not.toHaveBeenCalled();
      expect(result.urls).toEqual([]);
    }
  });

  it("should still accept normal valid URLs", async () => {
    const validUrls = [
      "https://example.com/page",
      "https://example.com/page?query=value",
      "https://example.com/page?q=test&foo=bar",
      "https://example.com/path/to/resource",
      "https://example.com/page#anchor",
    ];

    for (const validUrl of validUrls) {
      vi.clearAllMocks();
      const result = await runLinkUnderstanding(createTestConfig(validUrl));

      // Should execute with valid URL
      expect(exec.runExec).toHaveBeenCalledWith("curl", [validUrl], expect.any(Object));
      expect(result.urls).toEqual([validUrl]);
    }
  });
});
