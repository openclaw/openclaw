import { describe, expect, it } from "vitest";
import { normalizeFeishuTarget } from "./feishu.js";

describe("normalizeFeishuTarget", () => {
  it("returns plain ID unchanged", () => {
    expect(normalizeFeishuTarget("oc_abc123")).toBe("oc_abc123");
  });

  it("strips feishu: prefix", () => {
    expect(normalizeFeishuTarget("feishu:oc_abc123")).toBe("oc_abc123");
  });

  it("strips lark: prefix", () => {
    expect(normalizeFeishuTarget("lark:oc_abc123")).toBe("oc_abc123");
  });

  it("is case-insensitive for channel prefix", () => {
    expect(normalizeFeishuTarget("Feishu:oc_abc123")).toBe("oc_abc123");
    expect(normalizeFeishuTarget("LARK:oc_abc123")).toBe("oc_abc123");
  });

  it("strips group: subprefix", () => {
    expect(normalizeFeishuTarget("feishu:group:oc_abc123")).toBe("oc_abc123");
  });

  it("strips chat: subprefix", () => {
    expect(normalizeFeishuTarget("lark:chat:oc_abc123")).toBe("oc_abc123");
  });

  it("strips user: subprefix", () => {
    expect(normalizeFeishuTarget("feishu:user:ou_abc123")).toBe("ou_abc123");
  });

  it("strips dm: subprefix", () => {
    expect(normalizeFeishuTarget("lark:dm:ou_abc123")).toBe("ou_abc123");
  });

  it("strips standalone group: prefix", () => {
    expect(normalizeFeishuTarget("group:oc_abc123")).toBe("oc_abc123");
  });

  it("trims whitespace", () => {
    expect(normalizeFeishuTarget("feishu: oc_abc123 ")).toBe("oc_abc123");
  });
});
