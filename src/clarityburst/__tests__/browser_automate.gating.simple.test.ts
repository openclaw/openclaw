import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Page } from "playwright-core";
import {
  applyBrowserAutomateGateAndNavigate,
  applyBrowserAutomateGateAndClick,
  applyBrowserAutomateGateAndFill,
  applyBrowserAutomateGateAndPress,
  applyBrowserAutomateGateAndEvaluate,
} from "../browser-automate-gating.js";
import { ClarityBurstAbstainError } from "../errors.js";
import * as decisionOverride from "../decision-override.js";

// Mock the decision override module
vi.mock("../decision-override.js");

describe("BROWSER_AUTOMATE Gating", () => {
  let mockPage: Partial<Page>;
  let applyBrowserAutomateOverridesMock: any;

  beforeEach(() => {
    // Create a mock page object
    mockPage = {
      goto: vi.fn().mockResolvedValue({ status: () => 200 }),
      click: vi.fn().mockResolvedValue(undefined),
      fill: vi.fn().mockResolvedValue(undefined),
      press: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue("result"),
      url: vi.fn().mockReturnValue("https://example.com/page"),
    };

    // Setup the mocked override function
    applyBrowserAutomateOverridesMock = vi.fn();
    (decisionOverride.applyBrowserAutomateOverrides as any) = applyBrowserAutomateOverridesMock;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Navigation (page.goto) Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Navigation (page.goto)", () => {
    it("PROCEED: allows navigation unchanged", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_NAVIGATE",
      });

      const result = await applyBrowserAutomateGateAndNavigate(mockPage as Page, "https://example.com");

      expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", undefined);
      expect(result).toBeDefined();
    });

    it("PROCEED: preserves navigation options", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_NAVIGATE",
      });

      const opts = { timeout: 30000, waitUntil: "networkidle" as const };
      await applyBrowserAutomateGateAndNavigate(mockPage as Page, "https://example.com", opts);

      expect(mockPage.goto).toHaveBeenCalledWith("https://example.com", opts);
    });

    it("ABSTAIN_CONFIRM: blocks navigation before side effect", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "BROWSER_NAVIGATE_HIGH_RISK",
        instructions: "Navigation requires explicit confirmation",
      });

      await expect(applyBrowserAutomateGateAndNavigate(mockPage as Page, "https://example.com")).rejects.toThrow(
        ClarityBurstAbstainError
      );

      // Verify page.goto was never called
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    it("ABSTAIN_CLARIFY: blocks navigation before side effect", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
        contractId: null,
        instructions: "Pack policy incomplete",
      });

      await expect(applyBrowserAutomateGateAndNavigate(mockPage as Page, "https://example.com")).rejects.toThrow(
        ClarityBurstAbstainError
      );

      // Verify page.goto was never called
      expect(mockPage.goto).not.toHaveBeenCalled();
    });

    it("captures action type and target URL in context", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_NAVIGATE",
      });

      await applyBrowserAutomateGateAndNavigate(mockPage as Page, "https://example.com/path");

      expect(applyBrowserAutomateOverridesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          stageId: "BROWSER_AUTOMATE",
          action: "navigate",
          url: "example.com",
        })
      );
    });

    it("gate executes before page.goto", async () => {
      const callOrder: string[] = [];

      applyBrowserAutomateOverridesMock.mockImplementation(async () => {
        callOrder.push("gate");
        return { outcome: "PROCEED", contractId: "BROWSER_NAVIGATE" };
      });

      (mockPage.goto as any).mockImplementation(async () => {
        callOrder.push("goto");
        return { status: () => 200 };
      });

      await applyBrowserAutomateGateAndNavigate(mockPage as Page, "https://example.com");

      expect(callOrder).toEqual(["gate", "goto"]);
    });

    it("error contains correct abstain properties", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "BROWSER_NAVIGATE_HIGH_RISK",
        instructions: "Navigation requires explicit confirmation",
      });

      try {
        await applyBrowserAutomateGateAndNavigate(mockPage as Page, "https://example.com");
        expect.fail("Should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(ClarityBurstAbstainError);
        expect((error as ClarityBurstAbstainError).stageId).toBe("BROWSER_AUTOMATE");
        expect((error as ClarityBurstAbstainError).outcome).toBe("ABSTAIN_CONFIRM");
        expect((error as ClarityBurstAbstainError).contractId).toBe("BROWSER_NAVIGATE_HIGH_RISK");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Click Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Click (page.click)", () => {
    it("PROCEED: allows click unchanged", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_CLICK",
      });

      await applyBrowserAutomateGateAndClick(mockPage as Page, "button#submit");

      expect(mockPage.click).toHaveBeenCalledWith("button#submit", undefined);
    });

    it("ABSTAIN_CONFIRM: blocks click before side effect", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "BROWSER_CLICK_FORM_SUBMIT",
      });

      await expect(applyBrowserAutomateGateAndClick(mockPage as Page, "button#submit")).rejects.toThrow(
        ClarityBurstAbstainError
      );

      expect(mockPage.click).not.toHaveBeenCalled();
    });

    it("ABSTAIN_CLARIFY: blocks click before side effect", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
      });

      await expect(applyBrowserAutomateGateAndClick(mockPage as Page, "button#submit")).rejects.toThrow(
        ClarityBurstAbstainError
      );

      expect(mockPage.click).not.toHaveBeenCalled();
    });

    it("captures selector and URL in context", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_CLICK",
      });

      await applyBrowserAutomateGateAndClick(mockPage as Page, "button.btn-danger");

      expect(applyBrowserAutomateOverridesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          stageId: "BROWSER_AUTOMATE",
          action: "click",
          selector: "button.btn-danger",
          url: "example.com",
        })
      );
    });

    it("gate executes before page.click", async () => {
      const callOrder: string[] = [];

      applyBrowserAutomateOverridesMock.mockImplementation(async () => {
        callOrder.push("gate");
        return { outcome: "PROCEED", contractId: "BROWSER_CLICK" };
      });

      (mockPage.click as any).mockImplementation(async () => {
        callOrder.push("click");
      });

      await applyBrowserAutomateGateAndClick(mockPage as Page, "button#submit");

      expect(callOrder).toEqual(["gate", "click"]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Fill (Input Submission) Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Fill (page.fill)", () => {
    it("PROCEED: allows fill unchanged", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_FILL",
      });

      await applyBrowserAutomateGateAndFill(mockPage as Page, "input#email", "user@example.com");

      expect(mockPage.fill).toHaveBeenCalledWith("input#email", "user@example.com", undefined);
    });

    it("ABSTAIN_CONFIRM: blocks fill before side effect", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "BROWSER_FILL_PASSWORD",
      });

      await expect(applyBrowserAutomateGateAndFill(mockPage as Page, "input#password", "secret")).rejects.toThrow(
        ClarityBurstAbstainError
      );

      expect(mockPage.fill).not.toHaveBeenCalled();
    });

    it("ABSTAIN_CLARIFY: blocks fill before side effect", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "ROUTER_UNAVAILABLE",
        contractId: null,
      });

      await expect(applyBrowserAutomateGateAndFill(mockPage as Page, "input#password", "secret")).rejects.toThrow(
        ClarityBurstAbstainError
      );

      expect(mockPage.fill).not.toHaveBeenCalled();
    });

    it("captures selector and text in context", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_FILL",
      });

      await applyBrowserAutomateGateAndFill(mockPage as Page, "input#username", "myuser");

      expect(applyBrowserAutomateOverridesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          stageId: "BROWSER_AUTOMATE",
          action: "fill",
          selector: "input#username",
          url: "example.com",
        })
      );
    });

    it("gate executes before page.fill", async () => {
      const callOrder: string[] = [];

      applyBrowserAutomateOverridesMock.mockImplementation(async () => {
        callOrder.push("gate");
        return { outcome: "PROCEED", contractId: "BROWSER_FILL" };
      });

      (mockPage.fill as any).mockImplementation(async () => {
        callOrder.push("fill");
      });

      await applyBrowserAutomateGateAndFill(mockPage as Page, "input#email", "user@example.com");

      expect(callOrder).toEqual(["gate", "fill"]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Press (Keyboard) Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Press (page.press)", () => {
    it("PROCEED: allows press unchanged", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_PRESS",
      });

      await applyBrowserAutomateGateAndPress(mockPage as Page, "input#search", "Enter");

      expect(mockPage.press).toHaveBeenCalledWith("input#search", "Enter", undefined);
    });

    it("ABSTAIN_CONFIRM: blocks press before side effect", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "BROWSER_PRESS_SEARCH",
      });

      await expect(applyBrowserAutomateGateAndPress(mockPage as Page, "input#search", "Enter")).rejects.toThrow(
        ClarityBurstAbstainError
      );

      expect(mockPage.press).not.toHaveBeenCalled();
    });

    it("ABSTAIN_CLARIFY: blocks press before side effect", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
      });

      await expect(applyBrowserAutomateGateAndPress(mockPage as Page, "input#search", "Enter")).rejects.toThrow(
        ClarityBurstAbstainError
      );

      expect(mockPage.press).not.toHaveBeenCalled();
    });

    it("captures selector and key in context", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_PRESS",
      });

      await applyBrowserAutomateGateAndPress(mockPage as Page, "input#field", "Tab");

      expect(applyBrowserAutomateOverridesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          stageId: "BROWSER_AUTOMATE",
          action: "press",
          selector: "input#field",
          url: "example.com",
        })
      );
    });

    it("gate executes before page.press", async () => {
      const callOrder: string[] = [];

      applyBrowserAutomateOverridesMock.mockImplementation(async () => {
        callOrder.push("gate");
        return { outcome: "PROCEED", contractId: "BROWSER_PRESS" };
      });

      (mockPage.press as any).mockImplementation(async () => {
        callOrder.push("press");
      });

      await applyBrowserAutomateGateAndPress(mockPage as Page, "input#search", "Enter");

      expect(callOrder).toEqual(["gate", "press"]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Evaluate Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Evaluate (page.evaluate)", () => {
    it("PROCEED: allows evaluate unchanged", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_EVALUATE",
      });

      const fn = () => "result";
      const result = await applyBrowserAutomateGateAndEvaluate(mockPage as Page, fn);

      expect(mockPage.evaluate).toHaveBeenCalled();
      expect(result).toBe("result");
    });

    it("PROCEED: handles evaluate with argument", async () => {
      (mockPage.evaluate as any).mockResolvedValue(42);
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_EVALUATE",
      });

      const fn = (x: number) => x * 2;
      const result = await applyBrowserAutomateGateAndEvaluate(mockPage as Page, fn, 21);

      expect(mockPage.evaluate).toHaveBeenCalled();
      expect(result).toBe(42);
    });

    it("ABSTAIN_CONFIRM: blocks evaluate before side effect", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "BROWSER_EVALUATE_FORM_SUBMIT",
      });

      const fn = () => {
        (document as any).querySelector("form")?.submit?.();
      };

      await expect(applyBrowserAutomateGateAndEvaluate(mockPage as Page, fn)).rejects.toThrow(ClarityBurstAbstainError);

      expect(mockPage.evaluate).not.toHaveBeenCalled();
    });

    it("ABSTAIN_CLARIFY: blocks evaluate before side effect", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "ROUTER_UNAVAILABLE",
        contractId: null,
      });

      const fn = () => "test";

      await expect(applyBrowserAutomateGateAndEvaluate(mockPage as Page, fn)).rejects.toThrow(ClarityBurstAbstainError);

      expect(mockPage.evaluate).not.toHaveBeenCalled();
    });

    it("captures action type in context", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_EVALUATE",
      });

      const fn = () => "test";
      await applyBrowserAutomateGateAndEvaluate(mockPage as Page, fn);

      expect(applyBrowserAutomateOverridesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          stageId: "BROWSER_AUTOMATE",
          action: "evaluate",
          url: "example.com",
        })
      );
    });

    it("gate executes before page.evaluate", async () => {
      const callOrder: string[] = [];

      applyBrowserAutomateOverridesMock.mockImplementation(async () => {
        callOrder.push("gate");
        return { outcome: "PROCEED", contractId: "BROWSER_EVALUATE" };
      });

      (mockPage.evaluate as any).mockImplementation(async () => {
        callOrder.push("evaluate");
        return "result";
      });

      const fn = () => "result";
      await applyBrowserAutomateGateAndEvaluate(mockPage as Page, fn);

      expect(callOrder).toEqual(["gate", "evaluate"]);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Cross-Action Execution Order Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Execution Order", () => {
    it("gate executes exactly once per action", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_NAVIGATE",
      });

      await applyBrowserAutomateGateAndNavigate(mockPage as Page, "https://example.com");

      expect(applyBrowserAutomateOverridesMock).toHaveBeenCalledTimes(1);
    });

    it("browser action is never called if gate abstains", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "BROWSER_NAVIGATE_HIGH_RISK",
      });

      try {
        await applyBrowserAutomateGateAndNavigate(mockPage as Page, "https://example.com");
      } catch {
        // Expected
      }

      expect(mockPage.goto).not.toHaveBeenCalled();
      expect(mockPage.click).not.toHaveBeenCalled();
      expect(mockPage.fill).not.toHaveBeenCalled();
      expect(mockPage.press).not.toHaveBeenCalled();
      expect(mockPage.evaluate).not.toHaveBeenCalled();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Error Handling Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("Error Handling", () => {
    it("abstain error has correct stageId", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "TEST",
      });

      try {
        await applyBrowserAutomateGateAndNavigate(mockPage as Page, "https://example.com");
        expect.fail("Should have thrown");
      } catch (error) {
        expect((error as any).stageId).toBe("BROWSER_AUTOMATE");
      }
    });

    it("abstain error has correct outcome", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
      });

      try {
        await applyBrowserAutomateGateAndClick(mockPage as Page, "button");
        expect.fail("Should have thrown");
      } catch (error) {
        expect((error as any).outcome).toBe("ABSTAIN_CLARIFY");
      }
    });

    it("abstain error includes instructions", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "TEST",
        instructions: "Custom instruction text",
      });

      try {
        await applyBrowserAutomateGateAndFill(mockPage as Page, "input#field", "value");
        expect.fail("Should have thrown");
      } catch (error) {
        expect((error as any).instructions).toContain("Custom instruction text");
      }
    });

    it("default instructions when none provided", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "ABSTAIN_CONFIRM",
        reason: "CONFIRM_REQUIRED",
        contractId: "TEST",
      });

      try {
        await applyBrowserAutomateGateAndNavigate(mockPage as Page, "https://example.com");
        expect.fail("Should have thrown");
      } catch (error) {
        expect((error as any).instructions).toContain("example.com");
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // URL Extraction Tests
  // ─────────────────────────────────────────────────────────────────────────────

  describe("URL/Hostname Extraction", () => {
    it("extracts hostname from full URL", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_NAVIGATE",
      });

      await applyBrowserAutomateGateAndNavigate(mockPage as Page, "https://subdomain.example.com/path?query=value");

      expect(applyBrowserAutomateOverridesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "subdomain.example.com",
        })
      );
    });

    it("handles invalid URL gracefully", async () => {
      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_NAVIGATE",
      });

      await applyBrowserAutomateGateAndNavigate(mockPage as Page, "not-a-valid-url");

      // Should not throw, just use the raw URL
      expect(applyBrowserAutomateOverridesMock).toHaveBeenCalled();
    });

    it("handles missing page URL gracefully", async () => {
      (mockPage.url as any).mockImplementation(() => {
        throw new Error("Not attached to a page");
      });

      applyBrowserAutomateOverridesMock.mockResolvedValue({
        outcome: "PROCEED",
        contractId: "BROWSER_CLICK",
      });

      await applyBrowserAutomateGateAndClick(mockPage as Page, "button");

      expect(applyBrowserAutomateOverridesMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "unknown",
        })
      );
    });
  });
});
