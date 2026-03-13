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

    it("should accept prompts with bare $VAR (not exploitable without shell)", () => {
      expect(containsShellMetacharacters("explain $HOME")).toBe(false);
      expect(containsShellMetacharacters("what is $PATH?")).toBe(false);
    });

    it("should accept prompts with ; | > < (not exploitable without shell)", () => {
      expect(containsShellMetacharacters("describe; focus on color")).toBe(false);
      expect(containsShellMetacharacters("col1 | col2 | col3")).toBe(false);
      expect(containsShellMetacharacters("a > b comparison")).toBe(false);
      expect(containsShellMetacharacters("<value> placeholder")).toBe(false);
    });

    it("should accept prompts with && (not exploitable without shell)", () => {
      expect(containsShellMetacharacters("describe image && focus on detail")).toBe(false);
    });

    it("should accept normal prompt text", () => {
      expect(containsShellMetacharacters("Describe this image in detail")).toBe(false);
      expect(containsShellMetacharacters("What is shown in the photo?")).toBe(false);
      expect(containsShellMetacharacters("Transcribe the audio content")).toBe(false);
      expect(containsShellMetacharacters("Extract text from this document")).toBe(false);
    });
  });
});
