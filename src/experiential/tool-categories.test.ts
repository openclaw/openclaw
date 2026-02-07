import { describe, expect, it } from "vitest";
import { categorize, categorySignificanceWeight, isObservation } from "./tool-categories.js";

describe("tool-categories", () => {
  describe("categorize", () => {
    it("categorizes file operations", () => {
      expect(categorize("read_file")).toBe("file");
      expect(categorize("write_file")).toBe("file");
      expect(categorize("edit_file")).toBe("file");
      expect(categorize("glob")).toBe("file");
    });

    it("categorizes message operations", () => {
      expect(categorize("send_message")).toBe("message");
      expect(categorize("reply")).toBe("message");
    });

    it("categorizes exec operations", () => {
      expect(categorize("bash")).toBe("exec");
      expect(categorize("run_command")).toBe("exec");
    });

    it("categorizes browser operations", () => {
      expect(categorize("browse")).toBe("browser");
      expect(categorize("screenshot")).toBe("browser");
    });

    it("categorizes experience operations", () => {
      expect(categorize("remember")).toBe("experience");
      expect(categorize("memory_store")).toBe("experience");
    });

    it("returns null for unknown tools", () => {
      expect(categorize("unknown_tool")).toBeNull();
      expect(categorize("custom_action")).toBeNull();
    });

    it("handles case insensitive and dashes", () => {
      expect(categorize("Read_File")).toBe("file");
      expect(categorize("send-message")).toBe("message");
    });
  });

  describe("isObservation", () => {
    it("identifies observation tools", () => {
      expect(isObservation("read_file")).toBe(true);
      expect(isObservation("list_directory")).toBe(true);
      expect(isObservation("glob")).toBe(true);
      expect(isObservation("grep")).toBe(true);
      expect(isObservation("screenshot")).toBe(true);
    });

    it("identifies non-observation tools", () => {
      expect(isObservation("write_file")).toBe(false);
      expect(isObservation("send_message")).toBe(false);
      expect(isObservation("bash")).toBe(false);
    });
  });

  describe("categorySignificanceWeight", () => {
    it("returns correct weights for categories", () => {
      expect(categorySignificanceWeight("experience")).toBe(0.8);
      expect(categorySignificanceWeight("message")).toBe(0.7);
      expect(categorySignificanceWeight("file")).toBe(0.6);
      expect(categorySignificanceWeight("exec")).toBe(0.5);
      expect(categorySignificanceWeight("browser")).toBe(0.4);
      expect(categorySignificanceWeight("other")).toBe(0.3);
      expect(categorySignificanceWeight(null)).toBe(0.3);
    });
  });
});
