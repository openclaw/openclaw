import { describe, expect, it, vi } from "vitest";

import { createContextCommands, createDefaultCommands } from "./command-palette";

describe("createContextCommands", () => {
  const noop = () => {};

  it("returns empty array for tabs without context commands when no callbacks provided", () => {
    expect(createContextCommands("landing", {})).toEqual([]);
    expect(createContextCommands("overview", {})).toEqual([]);
    expect(createContextCommands("agents", {})).toEqual([]);
    expect(createContextCommands("instances", {})).toEqual([]);
    expect(createContextCommands("skills", {})).toEqual([]);
    expect(createContextCommands("debug", {})).toEqual([]);
  });

  it("returns chat-specific commands for chat tab", () => {
    const cmds = createContextCommands("chat", {
      newSession: noop,
      clearChat: noop,
      abortChat: noop,
    });

    expect(cmds).toHaveLength(3);
    expect(cmds.every((c) => c.category === "Current View")).toBe(true);
    expect(cmds.map((c) => c.id)).toEqual([
      "ctx-new-session",
      "ctx-clear-chat",
      "ctx-abort-chat",
    ]);
  });

  it("omits chat commands when callbacks are not provided", () => {
    const cmds = createContextCommands("chat", { newSession: noop });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id).toBe("ctx-new-session");
  });

  it("returns cron commands for cron tab", () => {
    const cmds = createContextCommands("cron", {
      addCronJob: noop,
      refreshCron: noop,
    });

    expect(cmds).toHaveLength(2);
    expect(cmds.map((c) => c.id)).toEqual(["ctx-add-cron", "ctx-refresh-cron"]);
  });

  it("returns overseer commands for overseer tab", () => {
    const cmds = createContextCommands("overseer", {
      createGoal: noop,
      refreshOverseer: noop,
    });

    expect(cmds).toHaveLength(2);
    expect(cmds.map((c) => c.id)).toEqual(["ctx-create-goal", "ctx-refresh-overseer"]);
  });

  it("returns config commands for config tab", () => {
    const cmds = createContextCommands("config", { saveConfig: noop });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id).toBe("ctx-save-config");
  });

  it("returns nodes commands for nodes tab", () => {
    const cmds = createContextCommands("nodes", { refreshNodes: noop });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id).toBe("ctx-refresh-nodes");
  });

  it("returns logs commands for logs tab", () => {
    const cmds = createContextCommands("logs", { clearLogs: noop });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id).toBe("ctx-clear-logs");
  });

  it("returns all logs commands when all callbacks provided", () => {
    const cmds = createContextCommands("logs", {
      clearLogs: noop,
      refreshLogs: noop,
      exportLogs: noop,
      toggleAutoFollow: noop,
      jumpToLogsBottom: noop,
    });
    expect(cmds).toHaveLength(5);
    expect(cmds.map((c) => c.id)).toEqual([
      "ctx-clear-logs",
      "ctx-refresh-logs",
      "ctx-export-logs",
      "ctx-toggle-follow",
      "ctx-jump-bottom",
    ]);
  });

  it("returns skills commands for skills tab", () => {
    const cmds = createContextCommands("skills", { refreshSkills: noop });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id).toBe("ctx-refresh-skills");
  });

  it("returns debug commands for debug tab", () => {
    const cmds = createContextCommands("debug", { refreshDebug: noop });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id).toBe("ctx-refresh-debug");
  });

  it("returns instances commands for instances tab", () => {
    const cmds = createContextCommands("instances", { refreshInstances: noop });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id).toBe("ctx-refresh-instances");
  });

  it("returns overview commands for overview tab", () => {
    const cmds = createContextCommands("overview", { refreshOverview: noop });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id).toBe("ctx-refresh-overview");
  });

  it("returns agents commands for agents tab", () => {
    const cmds = createContextCommands("agents", { refreshAgents: noop });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id).toBe("ctx-refresh-agents");
  });

  it("returns channels commands for channels tab", () => {
    const cmds = createContextCommands("channels", { refreshChannels: noop });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id).toBe("ctx-refresh-channels");
  });

  it("returns sessions commands for sessions tab", () => {
    const cmds = createContextCommands("sessions", { refreshSessions: noop });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].id).toBe("ctx-refresh-sessions");
  });

  it("calls the provided action when command is invoked", () => {
    const action = vi.fn();
    const cmds = createContextCommands("chat", { newSession: action });
    cmds[0].action();
    expect(action).toHaveBeenCalledOnce();
  });
});

describe("createDefaultCommands", () => {
  it("creates navigation and action commands", () => {
    const setTab = vi.fn();
    const refresh = vi.fn();
    const newSession = vi.fn();
    const toggleTheme = vi.fn();

    const cmds = createDefaultCommands(setTab, refresh, newSession, toggleTheme);

    // Should have navigation + action commands
    expect(cmds.length).toBeGreaterThan(10);

    const navCmds = cmds.filter((c) => c.category === "Navigation");
    const actionCmds = cmds.filter((c) => c.category === "Actions");

    expect(navCmds.length).toBeGreaterThan(0);
    expect(actionCmds.length).toBeGreaterThan(0);

    // Test navigation command triggers setTab
    const chatCmd = cmds.find((c) => c.id === "nav-chat");
    expect(chatCmd).toBeTruthy();
    chatCmd!.action();
    expect(setTab).toHaveBeenCalledWith("chat");

    // Test refresh command
    const refreshCmd = cmds.find((c) => c.id === "action-refresh");
    expect(refreshCmd).toBeTruthy();
    refreshCmd!.action();
    expect(refresh).toHaveBeenCalled();
  });

  it("includes system commands when extras are provided", () => {
    const setTab = vi.fn();
    const refresh = vi.fn();
    const newSession = vi.fn();
    const toggleTheme = vi.fn();
    const openShortcuts = vi.fn();
    const openDocs = vi.fn();
    const copyUrl = vi.fn();

    const cmds = createDefaultCommands(setTab, refresh, newSession, toggleTheme, {
      openKeyboardShortcuts: openShortcuts,
      openDocumentation: openDocs,
      copyGatewayUrl: copyUrl,
    });

    const sysCmds = cmds.filter((c) => c.category === "System");
    expect(sysCmds).toHaveLength(3);
    expect(sysCmds.map((c) => c.id)).toEqual([
      "sys-keyboard-shortcuts",
      "sys-open-docs",
      "sys-copy-url",
    ]);

    // Test system commands call the right actions
    sysCmds[0].action();
    expect(openShortcuts).toHaveBeenCalledOnce();
    sysCmds[1].action();
    expect(openDocs).toHaveBeenCalledOnce();
    sysCmds[2].action();
    expect(copyUrl).toHaveBeenCalledOnce();
  });

  it("omits system commands when extras not provided", () => {
    const cmds = createDefaultCommands(vi.fn(), vi.fn(), vi.fn(), vi.fn());
    const sysCmds = cmds.filter((c) => c.category === "System");
    expect(sysCmds).toHaveLength(0);
  });
});
