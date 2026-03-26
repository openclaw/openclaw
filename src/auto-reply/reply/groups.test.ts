import { describe, expect, it } from "vitest";
import type { TemplateContext } from "../templating.js";
import { buildGroupChatContext } from "./groups.js";

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

  it("includes group chat intro (no subject)", () => {
    const result = buildGroupChatContext({ sessionCtx: baseCtx });
    expect(result).toContain("group chat");
  });

  it("includes group name when subject is present", () => {
    const result = buildGroupChatContext({
      sessionCtx: { ...baseCtx, GroupSubject: "My Project Chat" } as TemplateContext,
    });
    expect(result).toContain('"My Project Chat"');
  });

  it("includes participants when members are present", () => {
    const result = buildGroupChatContext({
      sessionCtx: { ...baseCtx, GroupMembers: "Alice, Bob, Charlie" } as TemplateContext,
    });
    expect(result).toContain("Alice, Bob, Charlie");
  });

  it("guides text replies to reply directly without the message tool", () => {
    const result = buildGroupChatContext({ sessionCtx: baseCtx });
    expect(result).toContain("reply directly");
  });

  it("allows the message tool for sending attachments/files to the same group", () => {
    const result = buildGroupChatContext({ sessionCtx: baseCtx });
    // should not blanket-forbid the message tool
    expect(result).not.toContain("Do not use the message tool");
    // should allow message tool for attachments
    expect(result).toMatch(/message tool.*attachments|files.*message tool/i);
  });

  it("attachment guidance covers files, images, and attachments", () => {
    const result = buildGroupChatContext({ sessionCtx: baseCtx });
    expect(result).toMatch(/files|images|attachments/i);
  });
});
