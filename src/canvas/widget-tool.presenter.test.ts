import * as acorn from "acorn";
import { describe, expect, it, vi } from "vitest";
import type { BoardWidgetDataQuery } from "../../packages/gateway-protocol/src/index.js";
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

vi.mock("acorn", { spy: true });

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
      text: "Widget presented in the current channel as message message-1. The user sees it; do not restate its contents in text.",
    });
    expect(present).toHaveBeenCalledExactlyOnceWith({
      document: {
        kind: "html",
        html: buildWidgetDocument("Status", "<p>ready</p>"),
        source: "<p>ready</p>",
      },
      title: "Status",
      name: "status",
      context,
    });
    await expectNoDocument();
  });

  describe("channel-owned widget runtime", () => {
    const receipt = {
      primaryPlatformMessageId: "42",
      platformMessageIds: ["42"],
      parts: [],
      sentAt: 1,
    };
    const channelPresenter = (present: Parameters<typeof currentPresenter>[0]) =>
      currentPresenter(present, {
        capabilities: {
          sourceKinds: ["html"],
          authoringGuidance: "CHANNEL-RULES: draw from TelegramWidget.chatData.",
          state: { maxBytes: 8, description: "STATE-DOC" },
        },
      });

    it("replaces browser-host rules with the channel's rules and exposes state", () => {
      const tool = createTool({
        inlineClientAvailable: false,
        presenters: [channelPresenter(vi.fn())],
        presenterContext: { messageChannel: "telegram" },
      });
      expect(tool.description).toContain("CHANNEL-RULES");
      expect(tool.description).not.toContain("cdn.jsdelivr.net");
      const parameters = tool.parameters as {
        properties: Record<string, { description?: string }>;
      };
      expect(parameters.properties.state?.description).toBe("STATE-DOC");
    });

    it("sends a state-only update to the presenter without hosting a document", async () => {
      const present = vi.fn(async () => ({
        ok: true as const,
        value: { kind: "message" as const, receipt, updated: true },
      }));
      const context = { messageChannel: "telegram", currentMessageId: "query-1" };
      const tool = createTool({
        inlineClientAvailable: false,
        presenters: [channelPresenter(present)],
        presenterContext: context,
      });

      expect(
        payload(await run(tool, { title: "Vote", widget_code: undefined, state: '{"v":2}' })),
      ).toMatchObject({
        text: "Widget state updated in place on message 42. The user sees it; do not restate it in text.",
      });
      expect(present).toHaveBeenCalledExactlyOnceWith({
        document: { kind: "html", html: "", source: "" },
        title: "Vote",
        name: "vote",
        state: '{"v":2}',
        context,
      });
      await expectNoDocument();
    });

    it("refuses to pin channel-native widget code to the browser dashboard", async () => {
      const present = vi.fn();
      const tool = createTool({
        inlineClientAvailable: false,
        presenters: [channelPresenter(present)],
        presenterContext: { messageChannel: "telegram" },
        agentSessionKey: "agent:main:main",
      });
      await expect(
        run(tool, { title: "Vote", pin: true, widget_code: "<p id=o></p>" }),
      ).rejects.toThrow(/pin=true is unavailable for this channel's widgets/);
      expect(present).not.toHaveBeenCalled();
      await expectNoDocument();
    });

    it("passes an explicitly empty state through as a clearing update", async () => {
      const present = vi.fn(async () => ({
        ok: true as const,
        value: { kind: "message" as const, receipt, updated: true },
      }));
      const tool = createTool({
        inlineClientAvailable: false,
        presenters: [channelPresenter(present)],
        presenterContext: { messageChannel: "telegram", currentMessageId: "query-1" },
      });
      await run(tool, { title: "Vote", state: "" });
      expect(present).toHaveBeenCalledWith(expect.objectContaining({ state: "" }));
    });

    it("rejects oversized state before presenting", async () => {
      const present = vi.fn();
      const tool = createTool({
        inlineClientAvailable: false,
        presenters: [channelPresenter(present)],
        presenterContext: { messageChannel: "telegram" },
      });
      await expect(run(tool, { state: "123456789" })).rejects.toThrow(/state/);
      expect(present).not.toHaveBeenCalled();
    });

    it("rejects state on surfaces without a state-capable presenter", async () => {
      const tool = createTool({ inlineClientAvailable: true });
      await expect(run(tool, { state: "{}" })).rejects.toThrow("state is unavailable");
    });
  });
  it.each(["pending", "rejected", "granted"] as const)(
    "reports the owner's %s capability outcome",
    async (grantState) => {
      const { mock: put } = createBoardPutCaller(grantState);
      const query: BoardWidgetDataQuery = {
        name: "main-ci",
        bindingId: "github.actions.runs",
        params: {
          repository: "owner/repo",
          workflow: "ci.yml",
          branch: "main",
          status: null,
          created: null,
          perPage: 5,
          excludePullRequests: true,
        },
        fields: ["conclusion", "status"],
      };
      const tool = createTool({ agentSessionKey: "agent:main:approval", inlineHostEnabled: false });
      const result = await run(tool, {
        pin: true,
        capabilities: { queries: [query] },
      });
      expect(put).toHaveBeenCalledWith(
        "board.widget.put",
        expect.objectContaining({ declared: { queries: [query] } }),
      );
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
  it("reuses script validation across widget updates while keeping module grammar separate", async () => {
    const parse = vi.mocked(acorn.parse).mockClear();
    const present = vi.fn(async () => ({
      ok: true as const,
      value: {
        kind: "message" as const,
        receipt: { platformMessageIds: [], parts: [], sentAt: 1 },
      },
    }));
    const tool = createTool({ presenters: [currentPresenter(present)] });
    const script = "await Promise.resolve('widget-validation-reuse');";
    await Promise.all([
      run(tool, { widget_code: `<script type=module>${script}</script>` }),
      run(tool, { widget_code: `<p>Updated</p><script type=module>${script}</script>` }),
    ]);
    expect(parse).toHaveBeenCalledTimes(1);
    await expect(run(tool, { widget_code: `<script>${script}</script>` })).rejects.toThrow(
      "widget_code has a JavaScript syntax error",
    );
    await run(tool, { widget_code: `<script type=module>${script}</script>` });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(present).toHaveBeenCalledTimes(3);
  });
  it.each([false, true])(
    "rejects broken scripts before any side effect (large=%s)",
    async (large) => {
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
        widget_code: `<p>Widget</p>\n<script>${large ? `/*${"x".repeat(32 * 1024)}*/\n` : ""}const a='x\n'+b;</script>`,
        pin: true,
      });
      await expect(result).rejects.toThrow(WidgetHtmlInputError);
      await expect(result).rejects.toThrow(
        large
          ? "widget_code has a JavaScript syntax error in inline script 1 at line 3, column 8: Unterminated string constant. Offending line: const a='x. Fix the script and call show_widget again."
          : "widget_code has a JavaScript syntax error in inline script 1 at line 2, column 16: Unterminated string constant. Offending line: <script>const a='x. Fix the script and call show_widget again.",
      );
      expect(gateway).not.toHaveBeenCalled();
      expect(present).not.toHaveBeenCalled();
      expect(availability).not.toHaveBeenCalled();
      await expectNoDocument();
    },
  );
});
