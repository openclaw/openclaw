/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import type { SidebarContent } from "./sidebar-content.ts";

describe("OpenClawApp full-message sidebar upgrade", () => {
  it("uses string content returned by chat.message.get", async () => {
    const { OpenClawApp } = await import("./app.ts");
    const content: SidebarContent = {
      kind: "markdown",
      title: "Assistant",
      content: "short\n...(truncated)...",
      fullMessageRequest: {
        sessionKey: "main",
        messageId: "msg-1",
        kind: "assistant_message",
      },
    };
    const request = vi.fn(async () => ({
      ok: true,
      message: { role: "assistant", content: "full assistant text" },
    }));
    const app = new OpenClawApp() as InstanceType<typeof OpenClawApp> & {
      maybeUpgradeSidebarToFullMessage(content: SidebarContent): Promise<void>;
    };
    app.client = { request } as never;
    app.sidebarContent = content;
    app.sidebarError = null;

    await app.maybeUpgradeSidebarToFullMessage(content);

    expect(request).toHaveBeenCalledWith("chat.message.get", {
      sessionKey: "main",
      messageId: "msg-1",
      maxChars: 500_000,
    });
    expect(app.sidebarContent).toMatchObject({
      kind: "markdown",
      content: "full assistant text",
      rawText: "full assistant text",
      unavailableReason: null,
    });
  });
});
