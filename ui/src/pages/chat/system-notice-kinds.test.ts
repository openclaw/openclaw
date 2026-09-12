import { describe, expect, it } from "vitest";
import { resolveSystemNoticeKind } from "./system-notice-kinds.ts";

describe("resolveSystemNoticeKind", () => {
  it.each([
    [
      "main_session_restart_recovery",
      "chat.systemNotice.restartRecovery.label",
      "chat.systemNotice.restartRecovery.summary",
    ],
    ["restart-sentinel", "chat.systemNotice.gatewayRestarted.label", undefined],
  ])("resolves the canonical %s source tool", (sourceTool, labelKey, summaryKey) => {
    expect(resolveSystemNoticeKind(sourceTool)).toEqual(
      summaryKey === undefined ? { icon: "cpu", labelKey } : { icon: "cpu", labelKey, summaryKey },
    );
  });

  it("resolves Claude CLI task notifications as collapsed mid-run notices", () => {
    expect(resolveSystemNoticeKind("claude_cli_task_notification")).toEqual({
      icon: "cpu",
      labelKey: "chat.systemNotice.claudeCliTaskNotification.label",
      collapsedBody: true,
      startsTurn: false,
    });
  });

  it.each([
    undefined,
    "heartbeat",
    "main-session-restart-recovery",
    "restart_sentinel",
    " restart-sentinel ",
  ])("does not normalize or guess the unknown %s source tool", (sourceTool) => {
    expect(resolveSystemNoticeKind(sourceTool)).toBeUndefined();
  });
});
