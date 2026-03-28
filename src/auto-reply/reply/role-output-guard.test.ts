import { describe, expect, it } from "vitest";
import { applyRoleReplyGuard } from "./role-output-guard.js";

describe("applyRoleReplyGuard", () => {
  it("rewrites leaked coding intros for company role agents", () => {
    const result = applyRoleReplyGuard(
      {
        text: "你好，我是 OpenCode，你的智能编程助手。",
      },
      "executive-manager",
    );

    expect(result.text).toContain("职业经理人");
    expect(result.text).not.toContain("OpenCode");
    expect(result.text).not.toContain("编程助手");
  });

  it("rewrites generic identity drift for company role agents", () => {
    const result = applyRoleReplyGuard(
      {
        text: "我是一个智能软件工程顾问。",
      },
      "executive-manager",
    );

    expect(result.text).toContain("职业经理人");
    expect(result.text).not.toContain("软件工程顾问");
  });

  it("rewrites generic coding-helper intros for coder-bot", () => {
    const result = applyRoleReplyGuard(
      {
        text: "I can help write code changes and debug the issue.",
      },
      "coder-bot",
    );

    expect(result.text).toContain("coder-bot");
    expect(result.text).toContain("工程实现");
    expect(result.text).not.toContain("debug");
  });

  it("rewrites engineering role drift for reviewer-bot", () => {
    const result = applyRoleReplyGuard(
      {
        text: "我是工程实现 Bot，负责写代码和补测试。",
      },
      "reviewer-bot",
    );

    expect(result.text).toContain("reviewer-bot");
    expect(result.text).toContain("审查");
    expect(result.text).not.toContain("写代码");
  });

  it("leaves non-role agents unchanged", () => {
    const payload = {
      text: "你好，我是 OpenCode，你的智能编程助手。",
    };

    expect(applyRoleReplyGuard(payload, "main")).toEqual(payload);
  });

  it("leaves normal role replies unchanged", () => {
    const payload = {
      text: "经营判断：当前优先级先收敛需求，再安排 owner。",
    };

    expect(applyRoleReplyGuard(payload, "executive-manager")).toEqual(payload);
  });

  it("leaves structured reviewer output unchanged", () => {
    const payload = {
      text: "Review Verdict\nBlocking Findings\n- contract drift",
    };

    expect(applyRoleReplyGuard(payload, "reviewer-bot")).toEqual(payload);
  });

  it("leaves greeted bug findings unchanged", () => {
    const payload = {
      text: "Hello! I found a bug on line 42 of auth.ts.",
    };

    expect(applyRoleReplyGuard(payload, "reviewer-bot")).toEqual(payload);
  });

  it("leaves greeted debug feedback unchanged", () => {
    const payload = {
      text: "Hi, there's a debug log you left in the test.",
    };

    expect(applyRoleReplyGuard(payload, "reviewer-bot")).toEqual(payload);
  });
});
