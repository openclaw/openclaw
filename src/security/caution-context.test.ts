import { describe, expect, it } from "vitest";
import { createCautionContext } from "./caution-context.js";

describe("caution-context", () => {
  const mockModel = { id: "fast", provider: "test", api: "test" } as any;
  const mockRegistry = {} as any;

  describe("createCautionContext", () => {
    it("returns undefined when caution is disabled", () => {
      const ctx = createCautionContext({
        config: { tools: { caution: { enabled: false } } },
        originalUserMessage: "test",
        auditorModel: mockModel,
        modelRegistry: mockRegistry,
      });
      expect(ctx).toBeUndefined();
    });

    it("returns undefined when caution config is missing", () => {
      const ctx = createCautionContext({
        config: {},
        originalUserMessage: "test",
        auditorModel: mockModel,
        modelRegistry: mockRegistry,
      });
      expect(ctx).toBeUndefined();
    });

    it("creates context when caution is enabled", () => {
      const ctx = createCautionContext({
        config: { tools: { caution: { enabled: true } } },
        originalUserMessage: "test message",
        auditorModel: mockModel,
        modelRegistry: mockRegistry,
      });
      expect(ctx).toBeDefined();
      expect(ctx?.getOriginalUserMessage()).toBe("test message");
    });

    it("uses default auditor options", () => {
      const ctx = createCautionContext({
        config: { tools: { caution: { enabled: true } } },
        originalUserMessage: "test",
        auditorModel: mockModel,
        modelRegistry: mockRegistry,
      });
      expect(ctx?.auditorOptions.model).toBe("fast");
      expect(ctx?.auditorOptions.timeoutMs).toBe(3000);
      expect(ctx?.auditorOptions.failMode).toBe("block");
    });

    it("respects custom auditor options", () => {
      const ctx = createCautionContext({
        config: {
          tools: {
            caution: {
              enabled: true,
              auditor: {
                model: "custom",
                timeoutMs: 5000,
                failMode: "warn",
              },
            },
          },
        },
        originalUserMessage: "test",
        auditorModel: mockModel,
        modelRegistry: mockRegistry,
      });
      expect(ctx?.auditorOptions.model).toBe("custom");
      expect(ctx?.auditorOptions.timeoutMs).toBe(5000);
      expect(ctx?.auditorOptions.failMode).toBe("warn");
    });
  });

  describe("taint tracking", () => {
    it("starts with no taint", () => {
      const ctx = createCautionContext({
        config: { tools: { caution: { enabled: true } } },
        originalUserMessage: "test",
        auditorModel: mockModel,
        modelRegistry: mockRegistry,
      });
      expect(ctx?.isCautionTainted()).toBe(false);
    });

    it("sets taint when setCautionTaint is called", () => {
      const ctx = createCautionContext({
        config: { tools: { caution: { enabled: true } } },
        originalUserMessage: "test",
        auditorModel: mockModel,
        modelRegistry: mockRegistry,
      });
      ctx?.setCautionTaint("web_fetch");
      expect(ctx?.isCautionTainted()).toBe(true);
      expect(ctx?.getLastCautionedToolName()).toBe("web_fetch");
    });

    it("clears taint when clearCautionTaint is called", () => {
      const ctx = createCautionContext({
        config: { tools: { caution: { enabled: true } } },
        originalUserMessage: "test",
        auditorModel: mockModel,
        modelRegistry: mockRegistry,
      });
      ctx?.setCautionTaint("web_fetch");
      ctx?.clearCautionTaint();
      expect(ctx?.isCautionTainted()).toBe(false);
    });

    it("calls onBlock callback when audit blocks", () => {
      let blocked = false;
      let blockedTool = "";
      let blockedReason = "";
      const ctx = createCautionContext({
        config: { tools: { caution: { enabled: true } } },
        originalUserMessage: "test",
        auditorModel: mockModel,
        modelRegistry: mockRegistry,
        onBlock: (tool, reason) => {
          blocked = true;
          blockedTool = tool;
          blockedReason = reason ?? "";
        },
      });
      ctx?.onAuditBlock("message", "not aligned");
      expect(blocked).toBe(true);
      expect(blockedTool).toBe("message");
      expect(blockedReason).toBe("not aligned");
    });
  });
});
