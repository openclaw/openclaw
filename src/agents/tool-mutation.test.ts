import { describe, expect, it } from "vitest";
import {
  buildToolMutationState,
  isMutatingToolCall,
  isReplaySafeToolCall,
} from "./tool-mutation.js";

const words = (value: string) => value.trim().split(/\s+/);
function mutation(name: string, args: unknown, expected: boolean) {
  expect(buildToolMutationState(name, args).mutatingAction, name).toBe(expected);
}
function replay(name: string, args: unknown, expected: boolean) {
  expect(isReplaySafeToolCall(name, args), name).toBe(expected);
}
function actions(
  check: typeof mutation,
  name: string,
  values: string,
  expected: boolean,
  extra: Record<string, unknown> = {},
) {
  for (const action of words(values)) {
    check(name, { ...extra, action }, expected);
  }
}

describe("tool mutation helpers", () => {
  it("classifies presence observations as replay-safe", () => {
    expect(buildToolMutationState("presence", { action: "person" })).toEqual({
      mutatingAction: false,
      replaySafe: true,
    });
  });
  it("treats session_status as mutating only when model override is provided", () => {
    expect(isMutatingToolCall("session_status", { sessionKey: "agent:main:main" })).toBe(false);
    expect(
      isMutatingToolCall("session_status", {
        sessionKey: "agent:main:main",
        model: "openai/gpt-4o",
      }),
    ).toBe(true);
  });

  it.each([
    ["exec", "sed -n '1,220p' src/agents/tool-mutation.ts"],
    [
      "bash",
      "find . -maxdepth 1 -type f | wc -l && find . -maxdepth 1 -type f ! -name '.*' | wc -l",
    ],
    ["exec", 'rg -n "foo|bar" notes.md'],
    ["exec", "gh search prs --repo openclaw/openclaw tool-mutation --json number,title,state"],
  ])("treats read-only shell command as non-mutating: %s %s", (toolName, command) => {
    expect(isMutatingToolCall(toolName, { command })).toBe(false);
    expect(buildToolMutationState(toolName, { command }).mutatingAction).toBe(false);
  });

  it.each([
    ["exec", "sed -n '1p' -i file.txt"],
    ["exec", "rg 'literal'$(touch /tmp/out) notes.md"],
    ["exec", "rg '--pre=touch' notes.md"],
    ["bash", "find . -delete | wc -l"],
    ["bash", "find . -exec touch /tmp/out ';' | wc -l"],
    ["bash", "find . -type f | wc -l && touch /tmp/out"],
    ["bash", "find . -type f | wc -l &"],
    ["bash", "find . -type f |"],
    ["bash", "find . -type f | | wc -l"],
    ["exec", "gh pr create --title fix --body body"],
    ["exec", "gh pr view 123 -w"],
    ["exec", "gh issue comment 123 --body fixed"],
    ["exec", "gh api --method POST repos/openclaw/openclaw/issues"],
  ])("keeps ambiguous or mutating shell command mutating: %s %s", (toolName, command) => {
    expect(isMutatingToolCall(toolName, { command })).toBe(true);
    expect(buildToolMutationState(toolName, { command }).mutatingAction).toBe(true);
  });

  it("exposes mutation state for downstream payload rendering", () => {
    actions(mutation, "message", "send", true, { to: "forum:1" });
    actions(mutation, "message", "sendAttachment upload-file", true, { path: "/tmp/report.pdf" });
    actions(mutation, "message", "poll topic-create role-add ban future-action", true);
    actions(
      mutation,
      "message",
      "read reactions list-pins thread-list member-info channel-list voice-status event-list",
      false,
    );
    mutation("message", {}, true);
    actions(mutation, "browser", "list", false);
    actions(mutation, "subagents", "cancel kill steer", true, { target: "worker-1" });
    actions(mutation, "subagents", "list", false);
    actions(mutation, "sessions", "group_list", false);
    actions(mutation, "sessions", "patch", true);
    mutation("sessions_spawn", { task: "inspect the failure" }, true);
    actions(mutation, "process", "clear remove", true);
    actions(mutation, "cron", "runs", false);
    actions(mutation, "gateway", "config.get config.schema.lookup", false);
    actions(mutation, "gateway", "config.patch", true);
    actions(mutation, "nodes", "status describe pending", false);
    actions(mutation, "nodes", "approve", true);
    mutation("get_goal", { sessionKey: "agent:main" }, false);
    mutation("create_goal", { sessionKey: "agent:main" }, true);
    mutation("update_goal", { sessionKey: "agent:main", status: "complete" }, true);
  });

  it("classifies computer observations as replay-safe and input as mutating", () => {
    const observations = words(`screenshot wait list_apps list_windows get_accessibility_tree
      get_cursor_position get_window_state zoom get_browser_state get_recording_state`);
    const inputs = words(`left_click right_click middle_click double_click triple_click mouse_move
      left_click_drag left_mouse_down left_mouse_up scroll type key hold_key set_value invoke_menu
      bring_to_front launch_app kill_app escalate_scope browser_prepare browser_navigate browser_click
      browser_pointer browser_type browser_set_input_files browser_download start_recording
      stop_recording replay_trajectory future_action`);
    for (const [values, mutatingAction, replaySafe] of [
      [observations, false, true],
      [inputs, true, false],
    ] as const) {
      for (const action of values) {
        expect(buildToolMutationState("computer", { action }), action).toEqual({
          mutatingAction,
          replaySafe,
        });
      }
    }
    expect(isMutatingToolCall("computer", {})).toBe(true);
    expect(isReplaySafeToolCall("computer", {})).toBe(false);
  });

  it.each(["inspect", undefined])(
    "classifies computer dialog %s without granting input replay",
    (dialogAction) => {
      expect(
        buildToolMutationState("computer", { action: "browser_dialog", dialogAction }),
      ).toEqual({
        mutatingAction: dialogAction !== "inspect",
        replaySafe: dialogAction === "inspect",
      });
    },
  );

  it("preserves declared side effects for a computer observation", () => {
    expect(
      buildToolMutationState("computer", { action: "list_windows" }, { ownerKey: "plugin-owner" }),
    ).toEqual({ mutatingAction: true, replaySafe: false });
  });

  it("fails closed for replay unless the structured tool contract is read-only", () => {
    for (const name of words(`agents_list view_image pdf read conversations_list sessions_history
      sessions_list sessions_search tool_describe tool_search`)) {
      replay(name, {}, true);
    }
    replay("progress_card", { plan: [{ step: "Inspect", status: "in_progress" }] }, false);
    replay("memory_get", { path: "memory/notes.md" }, true);
    replay("memory_search", { query: "recall" }, false);
    replay("memory_recall", { query: "recall" }, false);
    actions(replay, "automations", "status", true);
    // Legacy transcript entries predate the rename and must stay classified.
    actions(replay, "cron", "status", true);
    actions(replay, "cron", "add", false);
    actions(replay, "gateway", "config.get config.schema.lookup", true);
    actions(replay, "gateway", "config.patch", false);
    actions(replay, "nodes", "status describe pending", true);
    actions(replay, "nodes", "approve", false);
    replay("exec", { command: "rg TODO src" }, false);
    actions(replay, "process", "list", true);
    actions(replay, "process", "log", true, { sessionId: "run-1" });
    actions(replay, "process", "poll", false, { sessionId: "run-1" });
    actions(replay, "browser", "tabs", true);
    actions(replay, "browser", "act", false, { kind: "click" });
    actions(replay, "browser", "open", false, { url: "https://example.com" });
    actions(replay, "skill_workshop", "list inspect read", true);
    actions(replay, "skill_workshop", "create", false);
    actions(replay, "transcripts", "status", true);
    actions(replay, "transcripts", "import", false);
    replay("subagents", {}, true);
    actions(replay, "subagents", "list", true);
    actions(replay, "subagents", "kill", false);
    replay("dispatch_action", { id: "sessions_list" }, false);
    actions(replay, "unknown_plugin_tool", "list", false);
    actions(replay, "survey_actions", "list poll", false);
  });
});
