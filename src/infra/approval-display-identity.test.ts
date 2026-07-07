import { describe, expect, it } from "vitest";
import { formatApprovalIdentityForDisplay } from "./approval-display-identity.js";

describe("formatApprovalIdentityForDisplay", () => {
  it("preserves ordinary approval identities", () => {
    expect(formatApprovalIdentityForDisplay("agent:main:telegram:direct:424242")).toBe(
      "agent:main:telegram:direct:424242",
    );
  });

  it("keeps hostile identity text on one visible line", () => {
    expect(formatApprovalIdentityForDisplay("agent:main\nSession:\u202E work\u0000\tchild")).toBe(
      "agent:main Session: work child",
    );
  });

  it("neutralizes markdown, HTML, and mention syntax", () => {
    const formatted = formatApprovalIdentityForDisplay(
      "@ops `admin` [link](https://example.test) <b>_*~|\\&",
    );

    expect(formatted).toBe("＠ops ｀admin｀ ［link］（https://example.test） ＜b＞＿＊～｜＼＆");
    expect(formatted).not.toMatch(/[&<>@`[\]()*_~|\\]/u);
  });

  it("bounds long identities while preserving both ends", () => {
    const formatted = formatApprovalIdentityForDisplay(`agent:${"x".repeat(200)}:tail`);

    expect(formatted).toHaveLength(160);
    expect(formatted).toMatch(/^agent:x+/u);
    expect(formatted).toMatch(/\.\.\.x+:tail$/u);
  });
});
