import { describe, expect, it } from "vitest";
import { buildGroupChatContext } from "./groups.js";
import type { TemplateContext } from "../templating.js";

describe("buildGroupChatContext", () => {
  const baseCtx: TemplateContext = {
    Provider: "telegram",
    GroupSubject: undefined,
    GroupMembers: undefined,
    From: undefined,
    GroupChannel: undefined,
    GroupSpace: undefined,
    AccountId: undefined,
  } as unknown as TemplateContext;

  it("包含群聊介绍（无主题）", () => {
    const result = buildGroupChatContext({ sessionCtx: baseCtx });
    expect(result).toContain("group chat");
  });

  it("包含群聊名称（有主题时）", () => {
    const result = buildGroupChatContext({
      sessionCtx: { ...baseCtx, GroupSubject: "My Project Chat" } as TemplateContext,
    });
    expect(result).toContain('"My Project Chat"');
  });

  it("包含参与者（有成员时）", () => {
    const result = buildGroupChatContext({
      sessionCtx: { ...baseCtx, GroupMembers: "Alice, Bob, Charlie" } as TemplateContext,
    });
    expect(result).toContain("Alice, Bob, Charlie");
  });

  it("文本回复指引：直接回复，不用 message 工具", () => {
    const result = buildGroupChatContext({ sessionCtx: baseCtx });
    // 应该建议文本直接回复
    expect(result).toContain("reply directly");
  });

  it("允许使用 message 工具发送附件/文件到同一群组", () => {
    const result = buildGroupChatContext({ sessionCtx: baseCtx });
    // 不应该完全禁止 message 工具
    expect(result).not.toContain("Do not use the message tool");
    // 应该允许附件使用 message 工具
    expect(result).toMatch(/message tool.*attachments|files.*message tool/i);
  });

  it("附件指引覆盖 files、images、attachments", () => {
    const result = buildGroupChatContext({ sessionCtx: baseCtx });
    // 应提到 files 和 images 等附件类型
    expect(result).toMatch(/files|images|attachments/i);
  });
});
