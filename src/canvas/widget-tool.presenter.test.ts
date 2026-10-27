import { describe, expect, it, vi } from "vitest";
import { WidgetHtmlInputError } from "../plugin-sdk/widget-html.js";
import type { WidgetPresenter } from "../plugins/plugin-registration.types.js";
import {
  createBoardPutCaller,
  currentPresenter,
  useWidgetHarness,
  runWidget as run,
  widgetPayload as payload,
} from "./widget-tool.test-support.js";
import { buildWidgetDocument } from "./wrap.js";

const { createTool, expectNoDocument } = useWidgetHarness();

describe("show_widget current-channel presentation", () => {
  it.each([false, true])("prefers the channel presenter (inline=%s)", async (inlineClient) => {
    const receipt = {
      primaryPlatformMessageId: "message-1",
      platformMessageIds: ["message-1"],
      parts: [],
      sentAt: 1,
    };
    const present = vi.fn(async () => ({
      ok: true as const,
      value: { kind: "message" as const, receipt },
    }));
    const context = { messageChannel: "discord", sessionKey: "agent:main:discord" };
    const presenter: WidgetPresenter = currentPresenter(present, {
      match: (candidate) => candidate.messageChannel === "discord",
    });
    const tool = createTool({
      sessionId: "current-channel",
      inlineClientAvailable: inlineClient,
      presenters: [presenter],
      presenterContext: context,
    });

    expect(tool.requiredClientCaps).toBeUndefined();
    expect(payload(await run(tool))).toMatchObject({
      kind: "widget",
      presentation: {
        target: "current_channel",
        title: "Status",
        receipt: { primaryPlatformMessageId: "message-1" },
      },
      text: "Widget presented in the current channel as message message-1",
    });
    expect(present).toHaveBeenCalledExactlyOnceWith({
      document: { kind: "html", html: buildWidgetDocument("Status", "<p>ready</p>") },
      title: "Status",
      context,
    });
    await expectNoDocument();
  });
  it.each(["pending", "rejected", "granted"] as const)(
    "reports the owner's %s capability outcome",
    async (grantState) => {
      createBoardPutCaller(grantState);
      const tool = createTool({ agentSessionKey: "agent:main:approval", inlineHostEnabled: false });
      const result = await run(tool, {
        pin: true,
        capabilities: { tools: ["github.actions.runs:owner/repo"] },
      });
      const parsed = payload(result);
      expect(parsed).toMatchObject({ boardWidgetName: "status", capabilityState: grantState });
      expect(parsed.text).toContain(grantState);
      if (grantState !== "granted") {
        expect(parsed.text).toMatch(/approve|review/i);
      }
    },
  );
  it("keeps scheduled widget authoring pinned-only without an inline client", async () => {
    createBoardPutCaller();
    const tool = createTool({
      sessionId: "scheduled-board-only",
      agentSessionKey: "agent:main:dashboard:scheduled",
      inlineClientAvailable: false,
      pinnedOnly: true,
    });
    expect(tool.requiredClientCaps).toBeUndefined();
    expect(tool.parameters).toHaveProperty("required", expect.arrayContaining(["pin"]));
    expect(tool.parameters).toHaveProperty("properties.pin.const", true);
    expect(tool.parameters).not.toHaveProperty("properties.presentation.properties.target");
    expect(tool.description).toContain("This surface is pinned-only");

    await expect(run(tool)).rejects.toThrow(
      "pin=true is required for this pinned-only widget surface",
    );
    await expect(
      run(tool, {
        pin: true,
        presentation: { target: "assistant_message" },
      }),
    ).rejects.toThrow("presentation.target is unavailable for this pinned-only widget surface");

    const result = await run(tool, { name: "scheduled-status", pin: true });
    expect(payload(result)).toEqual({
      status: "pinned",
      boardWidgetName: "scheduled-status",
      capabilityState: "none",
      text: "Widget pinned to dashboard tab main as scheduled-status. Open this dashboard tab in Control UI to view it.",
    });
    await expectNoDocument();
  });
  it("rejects broken scripts before any side effect", async () => {
    const { mock: gateway } = createBoardPutCaller();
    const present = vi.fn<WidgetPresenter["present"]>();
    const availability = vi.fn<WidgetPresenter["availability"]>();
    const tool = createTool({
      sessionId: "syntax",
      agentSessionKey: "agent:main:syntax",
      presenters: [{ target: "node_panel", description: "Test panel", availability, present }],
    });
    const result = tool.execute("broken", {
      title: "Broken widget",
      widget_code: "<p>Widget</p>\n<script>const a='x\n'+b;</script>",
      pin: true,
    });
    await expect(result).rejects.toThrow(WidgetHtmlInputError);
    await expect(result).rejects.toThrow(
      "widget_code has a JavaScript syntax error in inline script 1 at line 2, column 16: Unterminated string constant. Offending line: <script>const a='x. Fix the script and call show_widget again.",
    );
    expect(gateway).not.toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
    expect(availability).not.toHaveBeenCalled();
    await expectNoDocument();
  });
});
