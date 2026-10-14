import { access } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { WidgetHtmlInputError } from "../plugin-sdk/widget-html.js";
import type { WidgetPresenter } from "../plugins/plugin-registration.types.js";
import { resetPluginRuntimeStateForTest } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveCanvasDocumentsDir } from "./documents.js";
import { registerTestWidgetContentKind } from "./widget-tool.content-kinds.test-support.js";
import { createShowWidgetTool } from "./widget-tool.js";
import { createBoardPutCaller } from "./widget-tool.test-support.js";
import { buildWidgetDocument } from "./wrap.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => resetPluginRuntimeStateForTest());
afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  resetPluginRuntimeStateForTest();
});

describe("show_widget current-channel presentation", () => {
  it.each([false, true])("prefers the channel presenter (inline=%s)", async (inlineClient) => {
    const stateDir = tempDirs.make("openclaw-widget-presenter-");
    const present = vi.fn(async () => ({
      ok: true as const,
      value: {
        kind: "message" as const,
        receipt: {
          primaryPlatformMessageId: "message-1",
          platformMessageIds: ["message-1"],
          parts: [],
          sentAt: 1,
        },
      },
    }));
    const context = {
      messageChannel: "discord",
      accountId: "work",
      nativeChannelId: "channel-1",
      currentChannelId: "channel:channel-1",
      currentMessagingTarget: "discord:channel:channel-1",
      sessionKey: "agent:main:discord",
    };
    const presenter: WidgetPresenter = {
      target: "current_channel",
      description: "Post in the current channel",
      capabilities: { sourceKinds: ["html"], maxSourceBytes: 48 * 1024 },
      match: (candidate) => candidate.messageChannel === "discord",
      availability: async () => ({ ok: true, value: { available: true } }),
      present,
    };
    const tool = createShowWidgetTool({
      stateDir,
      sessionId: "current-channel",
      inlineClientAvailable: inlineClient,
      presenters: [presenter],
      presenterContext: context,
    });

    expect(tool.requiredClientCaps).toBeUndefined();
    expect(tool.description).toContain("current channel presenter");
    expect(tool.description).not.toContain("Keep one-off visualizations inline");
    expect(
      (tool.parameters as { properties?: { kind?: { enum?: string[] } } }).properties?.kind?.enum,
    ).toEqual(["html"]);
    const result = await tool.execute("current-channel", {
      title: "Status",
      widget_code: "<p>ready</p>",
    });
    const parsed = JSON.parse(result.content[0]?.type === "text" ? result.content[0].text : "null");

    expect(parsed).toMatchObject({
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
    await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();
  });
});

describe("show_widget capability outcomes", () => {
  it.each(["pending", "rejected", "granted"] as const)(
    "reports the owner's %s capability outcome",
    async (grantState) => {
      const { mock, callGateway } = createBoardPutCaller();
      const original = mock.getMockImplementation()!;
      mock.mockImplementation(async (...args) => {
        const snapshot = await original(...args);
        snapshot.widgets[0]!.grantState = grantState;
        return snapshot;
      });
      const tool = createShowWidgetTool({
        agentSessionKey: "agent:main:approval",
        inlineHostEnabled: false,
        callGateway,
      });
      const result = await tool.execute("pin", {
        title: "Runs",
        widget_code: "<p>runs</p>",
        pin: true,
        capabilities: { tools: ["github.actions.runs:owner/repo"] },
      });
      const text = result.content.find((item) => item.type === "text")?.text;
      if (!text) {
        throw new Error("expected widget tool text result");
      }
      const payload = JSON.parse(text);
      expect(payload).toMatchObject({ boardWidgetName: "runs", capabilityState: grantState });
      expect(payload.text).toContain(grantState);
      if (grantState !== "granted") {
        expect(payload.text).toMatch(/approve|review/i);
      }
    },
  );
});

describe("scheduled show_widget", () => {
  it("keeps scheduled widget authoring pinned-only without an inline client", async () => {
    const { mock: callGatewayMock, callGateway } = createBoardPutCaller();
    const stateDir = tempDirs.make("openclaw-scheduled-widget-");
    const tool = createShowWidgetTool({
      stateDir,
      sessionId: "scheduled-board-only",
      agentSessionKey: "agent:main:dashboard:scheduled",
      inlineClientAvailable: false,
      pinnedOnly: true,
      callGateway,
    });
    const schema = tool.parameters as {
      properties?: {
        pin?: { const?: boolean };
        presentation?: { properties?: { target?: unknown } };
      };
      required?: string[];
    };

    expect(tool.requiredClientCaps).toBeUndefined();
    expect(schema.required).toContain("pin");
    expect(schema.properties?.pin?.const).toBe(true);
    expect(schema.properties?.presentation?.properties).not.toHaveProperty("target");
    expect(tool.description).toContain("This surface is pinned-only");

    await expect(
      tool.execute("scheduled-unpinned", {
        title: "Scheduled status",
        widget_code: "<main>ready</main>",
      }),
    ).rejects.toThrow("pin=true is required for this pinned-only widget surface");
    await expect(
      tool.execute("scheduled-target", {
        title: "Scheduled status",
        widget_code: "<main>ready</main>",
        pin: true,
        presentation: { target: "assistant_message" },
      }),
    ).rejects.toThrow("presentation.target is unavailable for this pinned-only widget surface");

    const result = await tool.execute("scheduled-pinned", {
      title: "Scheduled status",
      widget_code: "<button onclick=\"this.textContent='updated'\">Update</button>",
      name: "scheduled-status",
      pin: true,
    });
    const text = result.content.find((item) => item.type === "text")?.text;
    expect(JSON.parse(text ?? "null")).toEqual({
      status: "pinned",
      boardWidgetName: "scheduled-status",
      capabilityState: "none",
      text: "Widget pinned to dashboard tab main as scheduled-status. Open this dashboard tab in Control UI to view it.",
    });
    expect(callGatewayMock).toHaveBeenCalledExactlyOnceWith(
      "board.widget.put",
      expect.objectContaining({
        sessionKey: "agent:main:dashboard:scheduled",
        name: "scheduled-status",
        content: {
          kind: "html",
          html: "<button onclick=\"this.textContent='updated'\">Update</button>",
        },
      }),
    );
    await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();
  });
});

describe("show_widget script syntax gate", () => {
  it("rejects broken scripts before any side effect", async () => {
    const stateDir = tempDirs.make("openclaw-widget-syntax-");
    const { mock: gateway, callGateway } = createBoardPutCaller();
    const present = vi.fn<WidgetPresenter["present"]>();
    const availability = vi.fn<WidgetPresenter["availability"]>();
    const presenters: WidgetPresenter[] = [
      { target: "node_panel", description: "Test panel", availability, present },
    ];
    const tool = createShowWidgetTool({
      stateDir,
      sessionId: "syntax",
      agentSessionKey: "agent:main:syntax",
      callGateway,
      presenters,
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
    await expect(access(resolveCanvasDocumentsDir(stateDir))).rejects.toThrow();
  });

  it("leaves registered source validation to the content kind", async () => {
    registerTestWidgetContentKind("diagram", () => "<p>Rendered diagram</p>");
    const stateDir = tempDirs.make("openclaw-widget-syntax-");
    const tool = createShowWidgetTool({ stateDir, sessionId: "registered-syntax" });
    expect(tool.description).toContain(
      "Keep one-off visualizations inline; pin for explicit dashboard requests or multiple non-code visualizations.",
    );
    expect(tool.description).toContain('Default videos to controls playsinline preload="auto"');
    expect(tool.description).toContain("do not autoplay");
    const result = await tool.execute("registered", {
      title: "Diagram",
      kind: "diagram",
      widget_code: "diagram:<script>const =</script>",
    });
    const text = result.content.find((item) => item.type === "text")?.text;
    expect(JSON.parse(text ?? "null")).toMatchObject({ kind: "canvas" });
  });
});
