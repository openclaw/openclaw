import { describe, it, expect } from "vitest";
import { processLatexForTerminal } from "./tui-math.ts";

describe("processLatexForTerminal", () => {
  describe("inline math ($...$)", () => {
    it("converts Greek letters", () => {
      expect(processLatexForTerminal("The angle $\\theta$ is small")).toBe("The angle θ is small");
    });

    it("converts fractions", () => {
      expect(processLatexForTerminal("$\\frac{a}{b}$")).toBe("a⁄b");
    });

    it("converts square roots", () => {
      expect(processLatexForTerminal("$\\sqrt{x}$")).toBe("√(x)");
    });

    it("converts superscripts", () => {
      expect(processLatexForTerminal("$x^{2}$")).toBe("x²");
      expect(processLatexForTerminal("$e^{i}$")).toBe("eⁱ");
    });

    it("converts subscripts", () => {
      expect(processLatexForTerminal("$x_{0}$")).toBe("x₀");
      expect(processLatexForTerminal("$a_{n}$")).toBe("aₙ");
    });

    it("converts operators", () => {
      expect(processLatexForTerminal("$\\sum_{i=0}^{n}$")).toBe("∑ᵢ₌₀ⁿ");
    });

    it("converts relations", () => {
      expect(processLatexForTerminal("$x \\leq y$")).toBe("x ≤ y");
      expect(processLatexForTerminal("$a \\neq b$")).toBe("a ≠ b");
      expect(processLatexForTerminal("$x \\approx y$")).toBe("x ≈ y");
    });

    it("converts set notation", () => {
      expect(processLatexForTerminal("$x \\in \\mathbb{R}$")).toBe("x ∈ ℝ");
      expect(processLatexForTerminal("$A \\subset B$")).toBe("A ⊂ B");
      expect(processLatexForTerminal("$A \\cup B$")).toBe("A ∪ B");
    });

    it("converts arrows", () => {
      expect(processLatexForTerminal("$x \\to y$")).toBe("x → y");
      expect(processLatexForTerminal("$A \\Rightarrow B$")).toBe("A ⇒ B");
    });

    it("converts blackboard bold", () => {
      expect(processLatexForTerminal("$\\mathbb{R}$")).toBe("ℝ");
      expect(processLatexForTerminal("$\\mathbb{N}$")).toBe("ℕ");
      expect(processLatexForTerminal("$\\mathbb{Z}$")).toBe("ℤ");
      expect(processLatexForTerminal("$\\mathbb{C}$")).toBe("ℂ");
    });

    it("converts accents", () => {
      expect(processLatexForTerminal("$\\hat{x}$")).toBe("x\u0302");
      expect(processLatexForTerminal("$\\bar{x}$")).toBe("x\u0304");
      expect(processLatexForTerminal("$\\vec{v}$")).toBe("v\u20D7");
    });

    it("converts logic symbols", () => {
      expect(processLatexForTerminal("$\\forall x \\exists y$")).toBe("∀ x ∃ y");
    });

    it("converts calculus symbols", () => {
      expect(processLatexForTerminal("$\\nabla f$")).toBe("∇ f");
      expect(processLatexForTerminal("$\\partial x$")).toBe("∂ x");
    });

    it("converts dots", () => {
      expect(processLatexForTerminal("$a, \\ldots, z$")).toBe("a, …, z");
    });

    it("handles complex expressions", () => {
      const input = "$E = mc^{2}$";
      expect(processLatexForTerminal(input)).toBe("E = mc²");
    });

    it("handles simple fraction", () => {
      const input = "$\\frac{a}{b}$";
      const result = processLatexForTerminal(input);
      expect(result).toContain("⁄");
    });
  });

  describe("display math ($$...$$)", () => {
    it("renders on its own line", () => {
      const result = processLatexForTerminal("Before $$E = mc^{2}$$ After");
      expect(result).toContain("\n");
      expect(result).toContain("E = mc²");
    });
  });

  describe("code block handling", () => {
    it("does not process LaTeX inside inline code", () => {
      expect(processLatexForTerminal("Use `$\\alpha$` for alpha")).toBe("Use `$\\alpha$` for alpha");
    });

    it("does not process LaTeX inside fenced code blocks", () => {
      const input = "```\n$\\alpha$\n```";
      expect(processLatexForTerminal(input)).toBe(input);
    });
  });

  describe("edge cases", () => {
    it("returns text unchanged when no math present", () => {
      expect(processLatexForTerminal("Hello world")).toBe("Hello world");
    });

    it("handles empty math blocks", () => {
      expect(processLatexForTerminal("$$")).toBe("$$");
    });

    it("handles multiple inline math expressions", () => {
      const result = processLatexForTerminal("$\\alpha$ and $\\beta$");
      expect(result).toBe("α and β");
    });

    it("strips unrecognized commands", () => {
      expect(processLatexForTerminal("$\\unknowncommand{x}$")).toBe("x");
    });
  });
});
