import { describe, expect, it } from "vitest";
import {
  findMatchingTab,
  formatReuseDecision,
  getDefaultConfig,
  shouldReuseTab,
  type TabInfo,
  type TabReuseConfig,
} from "./tab-reuse.js";

describe("tab-reuse", () => {
  const mockTabs: TabInfo[] = [
    {
      targetId: "tab1",
      url: "https://github.com/openclaw/openclaw",
      title: "OpenClaw GitHub",
      type: "page",
    },
    {
      targetId: "tab2",
      url: "https://github.com/openclaw/openclaw/issues",
      title: "Issues",
      type: "page",
    },
    {
      targetId: "tab3",
      url: "https://google.com/search?q=test",
      title: "Google Search",
      type: "page",
    },
    {
      targetId: "tab4",
      url: "https://example.com/",
      title: "Example",
      type: "page",
    },
  ];

  describe("findMatchingTab", () => {
    const config: TabReuseConfig = {
      enabled: true,
      matchDomain: true,
      matchExact: true,
      focusExisting: true,
    };

    it("should find exact URL match", () => {
      const result = findMatchingTab(
        "https://github.com/openclaw/openclaw",
        mockTabs,
        config
      );
      
      expect(result).not.toBeNull();
      expect(result?.targetId).toBe("tab1");
      expect(result?.url).toBe("https://github.com/openclaw/openclaw");
    });

    it("should find exact URL match ignoring trailing slash", () => {
      const result = findMatchingTab(
        "https://github.com/openclaw/openclaw/",
        mockTabs,
        config
      );
      
      expect(result).not.toBeNull();
      expect(result?.targetId).toBe("tab1");
    });

    it("should find exact URL match ignoring hash fragment", () => {
      const result = findMatchingTab(
        "https://github.com/openclaw/openclaw#readme",
        mockTabs,
        config
      );
      
      expect(result).not.toBeNull();
      expect(result?.targetId).toBe("tab1");
    });

    it("should find domain match when exact URL not found", () => {
      const result = findMatchingTab(
        "https://github.com/some/other/repo",
        mockTabs,
        config
      );
      
      expect(result).not.toBeNull();
      expect(result?.targetId).toBe("tab1"); // First github.com tab
    });

    it("should return null when no match found", () => {
      const result = findMatchingTab(
        "https://example.org/notfound",
        mockTabs,
        config
      );
      
      expect(result).toBeNull();
    });

    it("should return null when reuse disabled", () => {
      const disabledConfig: TabReuseConfig = {
        ...config,
        enabled: false,
      };
      
      const result = findMatchingTab(
        "https://github.com/openclaw/openclaw",
        mockTabs,
        disabledConfig
      );
      
      expect(result).toBeNull();
    });

    it("should not find domain match when matchDomain disabled", () => {
      const exactOnlyConfig: TabReuseConfig = {
        ...config,
        matchDomain: false,
      };
      
      const result = findMatchingTab(
        "https://github.com/some/other/repo",
        mockTabs,
        exactOnlyConfig
      );
      
      expect(result).toBeNull();
    });

    it("should prefer exact match over domain match", () => {
      const result = findMatchingTab(
        "https://github.com/openclaw/openclaw/issues",
        mockTabs,
        config
      );
      
      // Should match tab2 (exact) not tab1 (domain)
      expect(result?.targetId).toBe("tab2");
    });

    it("should handle empty tabs array", () => {
      const result = findMatchingTab(
        "https://github.com/openclaw/openclaw",
        [],
        config
      );
      
      expect(result).toBeNull();
    });

    it("should filter out non-page tabs", () => {
      const tabsWithWorker: TabInfo[] = [
        ...mockTabs,
        {
          targetId: "worker1",
          url: "https://github.com/worker.js",
          type: "service_worker",
        },
      ];
      
      const result = findMatchingTab(
        "https://github.com/worker.js",
        tabsWithWorker,
        config
      );
      
      // Should not match the service worker
      // Should match tab1 (domain match)
      expect(result?.targetId).toBe("tab1");
    });
  });

  describe("shouldReuseTab", () => {
    const config: TabReuseConfig = {
      enabled: true,
      matchDomain: true,
      matchExact: true,
      focusExisting: true,
    };

    it("should recommend reuse when exact match found", () => {
      const result = shouldReuseTab(
        "https://github.com/openclaw/openclaw",
        mockTabs,
        {},
        config
      );
      
      expect(result.reuse).toBe(true);
      expect(result.matchedTab?.targetId).toBe("tab1");
      expect(result.reason).toContain("exact URL");
    });

    it("should recommend reuse when domain match found", () => {
      const result = shouldReuseTab(
        "https://github.com/some/other/repo",
        mockTabs,
        {},
        config
      );
      
      expect(result.reuse).toBe(true);
      expect(result.matchedTab?.targetId).toBe("tab1");
      expect(result.reason).toContain("same domain");
    });

    it("should not reuse when forceNew option set", () => {
      const result = shouldReuseTab(
        "https://github.com/openclaw/openclaw",
        mockTabs,
        { forceNew: true },
        config
      );
      
      expect(result.reuse).toBe(false);
      expect(result.reason).toContain("forceNew");
    });

    it("should not reuse when config disabled", () => {
      const disabledConfig: TabReuseConfig = {
        ...config,
        enabled: false,
      };
      
      const result = shouldReuseTab(
        "https://github.com/openclaw/openclaw",
        mockTabs,
        {},
        disabledConfig
      );
      
      expect(result.reuse).toBe(false);
      expect(result.reason).toContain("disabled");
    });

    it("should respect matchDomain option override", () => {
      const result = shouldReuseTab(
        "https://github.com/some/other/repo",
        mockTabs,
        { matchDomain: false },
        config
      );
      
      expect(result.reuse).toBe(false);
      expect(result.reason).toContain("no matching tab");
    });

    it("should not reuse when no match found", () => {
      const result = shouldReuseTab(
        "https://example.org/notfound",
        mockTabs,
        {},
        config
      );
      
      expect(result.reuse).toBe(false);
      expect(result.reason).toContain("no matching tab");
    });
  });

  describe("formatReuseDecision", () => {
    it("should format reuse decision", () => {
      const result = {
        reuse: true,
        matchedTab: mockTabs[0],
        reason: "found exact URL match",
      };
      
      const formatted = formatReuseDecision(
        "https://github.com/openclaw/openclaw",
        result
      );
      
      expect(formatted).toContain("Reusing tab");
      expect(formatted).toContain("tab1");
      expect(formatted).toContain("github.com");
    });

    it("should format new tab decision", () => {
      const result = {
        reuse: false,
        reason: "no matching tab found",
      };
      
      const formatted = formatReuseDecision(
        "https://example.org/new",
        result
      );
      
      expect(formatted).toContain("Opening new tab");
      expect(formatted).toContain("example.org");
      expect(formatted).toContain("no matching tab");
    });
  });

  describe("getDefaultConfig", () => {
    it("should return default configuration", () => {
      const config = getDefaultConfig();
      
      expect(config.enabled).toBe(true);
      expect(config.matchDomain).toBe(true);
      expect(config.matchExact).toBe(true);
      expect(config.focusExisting).toBe(true);
    });

    it("should return independent copies", () => {
      const config1 = getDefaultConfig();
      const config2 = getDefaultConfig();
      
      config1.enabled = false;
      
      expect(config2.enabled).toBe(true);
    });
  });
});
