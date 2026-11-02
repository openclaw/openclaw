import { describe, expect, it } from "vitest";
import { renderMessagePresentationFallbackText } from "../../interactive/payload.js";
import { attachMcpConnectChannelAction } from "./mcp-connect-channel-action.js";

describe("attachMcpConnectChannelAction", () => {
  it("adds one portable URL action to the final visible reply", () => {
    const payloads = attachMcpConnectChannelAction({
      payloads: [{ text: "progress", isStatusNotice: true }, { text: "Sign in to continue." }],
      action: {
        serverName: "calendar",
        authorizationUrl: "https://auth.example/authorize?state=opaque",
      },
    });

    expect(renderMessagePresentationFallbackText(payloads[1]!)).toBe(
      "Sign in to continue.\n\n- Connect calendar: https://auth.example/authorize?state=opaque",
    );
  });

  it("preserves payloads without an action or eligible terminal reply", () => {
    const payloads = [{ text: "failed", isError: true }];
    expect(attachMcpConnectChannelAction({ payloads })).toBe(payloads);
    expect(
      attachMcpConnectChannelAction({
        payloads,
        action: { serverName: "calendar", authorizationUrl: "https://auth.example/authorize" },
      }),
    ).toBe(payloads);
  });

  it.each([
    ["bare", (url: string) => url],
    ["Markdown", (url: string) => `[Sign in](${url} "DFS login")`],
    ["autolink", (url: string) => `<${url}>`],
    ["URL-labelled Markdown", (url: string) => `[${url}](${url} "${url}")`],
    ["escaped Markdown", (url: string) => `[Sign in](${url.replaceAll("&", "\\&")})`],
    ["HTML-escaped Markdown", (url: string) => `[Sign in](${url.replaceAll("&", "&amp;")})`],
  ])("delivers only the current Connect link instead of a stale %s link", (_kind, link) => {
    const stale = "https://auth.example/authorize?client_id=calendar&state=old&code_challenge=old";
    const current =
      "https://auth.example/authorize?client_id=calendar&state=current&code_challenge=Current_CASE";
    const other = "https://docs.example/help";
    const source = {
      text: `Here's your login link:\n\n${link(stale)}\n\nKeep [these instructions](${other}).`,
    };
    const output = attachMcpConnectChannelAction({
      payloads: [{ text: stale }, source],
      action: { serverName: "calendar", authorizationUrl: current },
    });
    const delivered = output.map(renderMessagePresentationFallbackText).join("\n\n");
    expect(delivered).not.toContain(stale);
    expect(delivered.match(/https:\/\/auth\.example\/authorize[^\s]+/gu)).toEqual([current]);
    expect(delivered).toContain(`Keep [these instructions](${other}).`);
    expect(source.text).toContain(link(stale));
  });

  it("deduplicates a model-echoed current URL and preserves other clients' links", () => {
    const current = "https://auth.example/authorize?client_id=calendar&state=current";
    const other = "https://auth.example/authorize?client_id=mail&state=other";
    const output = attachMcpConnectChannelAction({
      payloads: [{ text: `Sign in: ${current}\n\nOther account: ${other}` }],
      action: { serverName: "calendar", authorizationUrl: current },
    });
    const delivered = output.map(renderMessagePresentationFallbackText).join("\n");
    expect(delivered.split(current)).toHaveLength(2);
    expect(delivered).toContain(other);
  });
});
