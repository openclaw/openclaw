import { describe, expect, it } from "vitest";
import { resolveSenderLabel } from "./grouped-render.ts";

describe("grouped-render", () => {
  describe("resolveSenderLabel", () => {
    it("labels user role as You", () => {
      expect(resolveSenderLabel("user", "Assistant")).toBe("You");
    });

    it("labels assistant role with assistant name", () => {
      expect(resolveSenderLabel("assistant", "Codex")).toBe("Codex");
    });

    it("labels system role as System", () => {
      expect(resolveSenderLabel("system", "Assistant")).toBe("System");
    });

    it("labels tool role as Tool", () => {
      expect(resolveSenderLabel("tool", "Assistant")).toBe("Tool");
    });
  });
});
