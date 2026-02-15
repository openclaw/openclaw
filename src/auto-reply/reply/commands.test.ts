import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
import {
  addSubagentRunForTests,
  listSubagentRunsForRequester,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.js";
import { updateSessionStore } from "../../config/sessions.js";
import * as internalHooks from "../../hooks/internal-hooks.js";
import { clearPluginCommands, registerPluginCommand } from "../../plugins/commands.js";
import { resetBashChatCommandForTests } from "./bash-command.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

import { handleCommands } from "./commands.js";

// Avoid expensive workspace scans during /context tests.
vi.mock("./commands-context-report.js", () => ({
  buildContextReply: async (params: { command: { commandBodyNormalized: string } }) => {
    const normalized = params.command.commandBodyNormalized;
    if (normalized === "/context list") {
      return { text: "Injected workspace files:\n- AGENTS.md" };
    }
    if (normalized === "/context detail") {
      return { text: "Context breakdown (detailed)\nTop tools (schema size):" };
    }
    return { text: "/context\n- /context list\nInline shortcut" };
  },
}));

let testWorkspaceDir = os.tmpdir();

beforeAll(async () => {
  testWorkspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-commands-"));
  await fs.writeFile(path.join(testWorkspaceDir, "AGENTS.md"), "# Agents\n", "utf-8");
});

afterAll(async () => {
  await fs.rm(testWorkspaceDir, { recursive: true, force: true });
});

function buildParams(commandBody: string, cfg: OpenClawConfig, ctxOverrides?: Partial<MsgContext>) {
  return buildCommandTestParams(commandBody, cfg, ctxOverrides, { workspaceDir: testWorkspaceDir });
}

describe("handleCommands gating", () => {
  it("blocks /bash when disabled", async () => {
    resetBashChatCommandForTests();
    const cfg = {
      commands: { bash: false, text: true },
      whatsapp: { allowFrom: ["*"] },
    } as OpenClawConfig;
    const params = buildParams("/bash echo hi", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("bash is disabled");
  });

  it("blocks /bash when elevated is not allowlisted", async () => {
    resetBashChatCommandForTests();
    const cfg = {
      commands: { bash: true, text: true },
      whatsapp: { allowFrom: ["*"] },
    } as OpenClawConfig;
    const params = buildParams("/bash echo hi", cfg);
    params.elevated = {
      enabled: true,
      allowed: false,
      failures: [{ gate: "allowFrom", key: "tools.elevated.allowFrom.whatsapp" }],
    };
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("elevated is not available");
  });

  it("blocks /config when disabled", async () => {
    const cfg = {
      commands: { config: false, debug: false, text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/config show", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/config is disabled");
  });

  it("blocks /debug when disabled", async () => {
    const cfg = {
      commands: { config: false, debug: false, text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/debug show", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/debug is disabled");
  });
});

describe("handleCommands bash alias", () => {
  it("routes !poll through the /bash handler", async () => {
    resetBashChatCommandForTests();
    const cfg = {
      commands: { bash: true, text: true },
      whatsapp: { allowFrom: ["*"] },
    } as OpenClawConfig;
    const params = buildParams("!poll", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("No active bash job");
  });

  it("routes !stop through the /bash handler", async () => {
    resetBashChatCommandForTests();
    const cfg = {
      commands: { bash: true, text: true },
      whatsapp: { allowFrom: ["*"] },
    } as OpenClawConfig;
    const params = buildParams("!stop", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("No active bash job");
  });
});

describe("handleCommands plugin commands", () => {
  it("dispatches registered plugin commands", async () => {
    clearPluginCommands();
    const result = registerPluginCommand("test-plugin", {
      name: "card",
      description: "Test card",
      handler: async () => ({ text: "from plugin" }),
    });
    expect(result.ok).toBe(true);

    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/card", cfg);
    const commandResult = await handleCommands(params);

    expect(commandResult.shouldContinue).toBe(false);
    expect(commandResult.reply?.text).toBe("from plugin");
    clearPluginCommands();
  });
});

describe("handleCommands identity", () => {
  it("returns sender details for /whoami", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/whoami", cfg, {
      SenderId: "12345",
      SenderUsername: "TestUser",
      ChatType: "direct",
    });
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Channel: whatsapp");
    expect(result.reply?.text).toContain("User id: 12345");
    expect(result.reply?.text).toContain("Username: @TestUser");
    expect(result.reply?.text).toContain("AllowFrom: 12345");
  });
});

describe("handleCommands hooks", () => {
  it("triggers hooks for /new with arguments", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/new take notes", cfg);
    const spy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();

    await handleCommands(params);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: "command", action: "new" }));
    spy.mockRestore();
  });

  it("triggers session:end before command:new when previous session exists", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/new", cfg);
    // Add previous session entry
    params.previousSessionEntry = {
      sessionId: "prev-session-id",
      sessionFile: "/tmp/prev-session.json",
      channel: "whatsapp",
      updatedAt: Date.now(),
    };
    params.sessionEntry = {
      sessionId: "new-session-id",
      sessionFile: "/tmp/new-session.json",
      channel: "whatsapp",
      updatedAt: Date.now(),
    };
    const spy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();

    await handleCommands(params);

    // Should trigger session:end, command:new, and session:start in order
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[0][0]).toMatchObject({ type: "session", action: "end" });
    expect(spy.mock.calls[1][0]).toMatchObject({ type: "command", action: "new" });
    expect(spy.mock.calls[2][0]).toMatchObject({ type: "session", action: "start" });
    spy.mockRestore();
  });

  it("triggers session:start with isReset context", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/reset", cfg);
    params.sessionEntry = {
      sessionId: "new-session-id",
      sessionFile: "/tmp/new-session.json",
      channel: "whatsapp",
      updatedAt: Date.now(),
    };
    const spy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();

    await handleCommands(params);

    // Find the session:start call
    const sessionStartCall = spy.mock.calls.find(
      (call) => call[0].type === "session" && call[0].action === "start",
    );
    expect(sessionStartCall).toBeDefined();
    expect(sessionStartCall?.[0].context).toMatchObject({ isReset: true });
    spy.mockRestore();
  });

  it("does not trigger session:end when no previous session exists", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/new", cfg);
    // No previousSessionEntry
    params.sessionEntry = {
      sessionId: "new-session-id",
      sessionFile: "/tmp/new-session.json",
      channel: "whatsapp",
      updatedAt: Date.now(),
    };
    const spy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();

    await handleCommands(params);

    // Should trigger command:new and session:start, but not session:end
    const sessionEndCall = spy.mock.calls.find(
      (call) => call[0].type === "session" && call[0].action === "end",
    );
    expect(sessionEndCall).toBeUndefined();
    spy.mockRestore();
  });

  it("session:end context includes reason, sessionId, sessionFile, and cfg", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/new", cfg);
    params.previousSessionEntry = {
      sessionId: "prev-session-id",
      sessionFile: "/tmp/prev-session.json",
      channel: "whatsapp",
      updatedAt: Date.now(),
    };
    params.sessionEntry = {
      sessionId: "new-session-id",
      sessionFile: "/tmp/new-session.json",
      channel: "whatsapp",
      updatedAt: Date.now(),
    };
    const spy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();

    await handleCommands(params);

    const sessionEndCall = spy.mock.calls.find(
      (call) => call[0].type === "session" && call[0].action === "end",
    );
    expect(sessionEndCall).toBeDefined();
    expect(sessionEndCall?.[0].context).toMatchObject({
      sessionId: "prev-session-id",
      sessionFile: "/tmp/prev-session.json",
      reason: "new",
      cfg,
    });
    spy.mockRestore();
  });

  it("session:end reason is 'reset' for /reset command", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/reset", cfg);
    params.previousSessionEntry = {
      sessionId: "prev-session-id",
      sessionFile: "/tmp/prev-session.json",
      channel: "whatsapp",
      updatedAt: Date.now(),
    };
    params.sessionEntry = {
      sessionId: "new-session-id",
      sessionFile: "/tmp/new-session.json",
      channel: "whatsapp",
      updatedAt: Date.now(),
    };
    const spy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();

    await handleCommands(params);

    const sessionEndCall = spy.mock.calls.find(
      (call) => call[0].type === "session" && call[0].action === "end",
    );
    expect(sessionEndCall).toBeDefined();
    expect(sessionEndCall?.[0].context).toMatchObject({ reason: "reset" });
    spy.mockRestore();
  });

  it("session:start context includes sessionId, sessionFile, isReset, and cfg", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/new", cfg);
    params.sessionEntry = {
      sessionId: "new-session-id",
      sessionFile: "/tmp/new-session.json",
      channel: "whatsapp",
      updatedAt: Date.now(),
    };
    const spy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();

    await handleCommands(params);

    const sessionStartCall = spy.mock.calls.find(
      (call) => call[0].type === "session" && call[0].action === "start",
    );
    expect(sessionStartCall).toBeDefined();
    expect(sessionStartCall?.[0].context).toMatchObject({
      sessionId: "new-session-id",
      sessionFile: "/tmp/new-session.json",
      isReset: false,
      cfg,
    });
    spy.mockRestore();
  });

  it("/reset triggers all three hooks in order (session:end, command:reset, session:start)", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/reset", cfg);
    params.previousSessionEntry = {
      sessionId: "prev-session-id",
      sessionFile: "/tmp/prev-session.json",
      channel: "whatsapp",
      updatedAt: Date.now(),
    };
    params.sessionEntry = {
      sessionId: "new-session-id",
      sessionFile: "/tmp/new-session.json",
      channel: "whatsapp",
      updatedAt: Date.now(),
    };
    const spy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();

    await handleCommands(params);

    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls[0][0]).toMatchObject({ type: "session", action: "end" });
    expect(spy.mock.calls[1][0]).toMatchObject({ type: "command", action: "reset" });
    expect(spy.mock.calls[2][0]).toMatchObject({ type: "session", action: "start" });
    expect(spy.mock.calls[2][0].context).toMatchObject({ isReset: true });
    spy.mockRestore();
  });

  it("does not trigger session:start when no sessionEntry exists", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/new", cfg);
    // No sessionEntry and no previousSessionEntry
    const spy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();

    await handleCommands(params);

    const sessionStartCall = spy.mock.calls.find(
      (call) => call[0].type === "session" && call[0].action === "start",
    );
    expect(sessionStartCall).toBeUndefined();
    spy.mockRestore();
  });

  it("does not trigger any hooks for unauthorized sender", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/new", cfg, { CommandAuthorized: false });
    params.sessionEntry = {
      sessionId: "new-session-id",
      sessionFile: "/tmp/new-session.json",
      channel: "whatsapp",
      updatedAt: Date.now(),
    };
    // Override isAuthorizedSender since buildCommandContext may set it from allowFrom
    params.command = { ...params.command, isAuthorizedSender: false };
    const spy = vi.spyOn(internalHooks, "triggerInternalHook").mockResolvedValue();

    const result = await handleCommands(params);

    expect(result.shouldContinue).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("handleCommands context", () => {
  it("returns context help for /context", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/context", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/context list");
    expect(result.reply?.text).toContain("Inline shortcut");
  });

  it("returns a per-file breakdown for /context list", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/context list", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Injected workspace files:");
    expect(result.reply?.text).toContain("AGENTS.md");
  });

  it("returns a detailed breakdown for /context detail", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/context detail", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Context breakdown (detailed)");
    expect(result.reply?.text).toContain("Top tools (schema size):");
  });
});

describe("handleCommands subagents", () => {
  it("lists subagents when none exist", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/subagents list", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("active subagents:");
    expect(result.reply?.text).toContain("active subagents:\n-----\n");
    expect(result.reply?.text).toContain("recent subagents (last 30m):");
    expect(result.reply?.text).toContain("\n\nrecent subagents (last 30m):");
    expect(result.reply?.text).toContain("recent subagents (last 30m):\n-----\n");
  });

  it("truncates long subagent task text in /subagents list", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    addSubagentRunForTests({
      runId: "run-long-task",
      childSessionKey: "agent:main:subagent:long-task",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "This is a deliberately long task description used to verify that subagent list output keeps the full task text instead of appending ellipsis after a short hard cutoff.",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/subagents list", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain(
      "This is a deliberately long task description used to verify that subagent list output keeps the full task text",
    );
    expect(result.reply?.text).toContain("...");
    expect(result.reply?.text).not.toContain("after a short hard cutoff.");
  });

  it("lists subagents for the current command session over the target session", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:slack:slash:u1",
      requesterDisplayKey: "agent:main:slack:slash:u1",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    addSubagentRunForTests({
      runId: "run-2",
      childSessionKey: "agent:main:subagent:def",
      requesterSessionKey: "agent:main:slack:slash:u1",
      requesterDisplayKey: "agent:main:slack:slash:u1",
      task: "another thing",
      cleanup: "keep",
      createdAt: 2000,
      startedAt: 2000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/subagents list", cfg, {
      CommandSource: "native",
      CommandTargetSessionKey: "agent:main:main",
    });
    params.sessionKey = "agent:main:slack:slash:u1";
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("active subagents:");
    expect(result.reply?.text).toContain("do thing");
    expect(result.reply?.text).not.toContain("\n\n2.");
  });

  it("formats subagent usage with io and prompt/cache breakdown", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    addSubagentRunForTests({
      runId: "run-usage",
      childSessionKey: "agent:main:subagent:usage",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const storePath = path.join(testWorkspaceDir, "sessions-subagents-usage.json");
    await updateSessionStore(storePath, (store) => {
      store["agent:main:subagent:usage"] = {
        sessionId: "child-session-usage",
        updatedAt: Date.now(),
        inputTokens: 12,
        outputTokens: 1000,
        totalTokens: 197000,
        model: "opencode/claude-opus-4-6",
      };
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    } as OpenClawConfig;
    const params = buildParams("/subagents list", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toMatch(/tokens 1(\.0)?k \(in 12 \/ out 1(\.0)?k\)/);
    expect(result.reply?.text).toContain("prompt/cache 197k");
    expect(result.reply?.text).not.toContain("1k io");
  });

  it("omits subagent status line when none exist", async () => {
    resetSubagentRegistryForTests();
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;
    const params = buildParams("/status", cfg);
    params.resolvedVerboseLevel = "on";
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).not.toContain("Subagents:");
  });

  it("returns help for unknown subagents action", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/subagents foo", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/subagents");
  });

  it("returns usage for subagents info without target", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/subagents info", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("/subagents info");
  });

  it("includes subagent count in /status when active", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;
    const params = buildParams("/status", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("🤖 Subagents: 1 active");
  });

  it("includes subagent details in /status when verbose", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    addSubagentRunForTests({
      runId: "run-2",
      childSessionKey: "agent:main:subagent:def",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "finished task",
      cleanup: "keep",
      createdAt: 900,
      startedAt: 900,
      endedAt: 1200,
      outcome: { status: "ok" },
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;
    const params = buildParams("/status", cfg);
    params.resolvedVerboseLevel = "on";
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("🤖 Subagents: 1 active");
    expect(result.reply?.text).toContain("· 1 done");
  });

  it("returns info for a subagent", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: now - 20_000,
      startedAt: now - 20_000,
      endedAt: now - 1_000,
      outcome: { status: "ok" },
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;
    const params = buildParams("/subagents info 1", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("Subagent info");
    expect(result.reply?.text).toContain("Run: run-1");
    expect(result.reply?.text).toContain("Status: done");
  });

  it("kills subagents via /kill alias without a confirmation reply", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/kill 1", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply).toBeUndefined();
  });

  it("resolves numeric aliases in active-first display order", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-active",
      childSessionKey: "agent:main:subagent:active",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "active task",
      cleanup: "keep",
      createdAt: now - 120_000,
      startedAt: now - 120_000,
    });
    addSubagentRunForTests({
      runId: "run-recent",
      childSessionKey: "agent:main:subagent:recent",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "recent task",
      cleanup: "keep",
      createdAt: now - 30_000,
      startedAt: now - 30_000,
      endedAt: now - 10_000,
      outcome: { status: "ok" },
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/kill 1", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply).toBeUndefined();
  });

  it("sends follow-up messages to finished subagents", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: { runId?: string } };
      if (request.method === "agent") {
        return { runId: "run-followup-1" };
      }
      if (request.method === "agent.wait") {
        return { status: "done" };
      }
      if (request.method === "chat.history") {
        return { messages: [] };
      }
      return {};
    });
    const now = Date.now();
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: now - 20_000,
      startedAt: now - 20_000,
      endedAt: now - 1_000,
      outcome: { status: "ok" },
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/subagents send 1 continue with follow-up details", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("✅ Sent to");

    const agentCall = callGatewayMock.mock.calls.find(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    expect(agentCall?.[0]).toMatchObject({
      method: "agent",
      params: {
        lane: "subagent",
        sessionKey: "agent:main:subagent:abc",
        timeout: 0,
      },
    });

    const waitCall = callGatewayMock.mock.calls.find(
      (call) =>
        (call[0] as { method?: string; params?: { runId?: string } }).method === "agent.wait" &&
        (call[0] as { method?: string; params?: { runId?: string } }).params?.runId ===
          "run-followup-1",
    );
    expect(waitCall).toBeDefined();
  });

  it("steers subagents via /steer alias", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-steer-1" };
      }
      return {};
    });
    const storePath = path.join(testWorkspaceDir, "sessions-subagents-steer.json");
    await updateSessionStore(storePath, (store) => {
      store["agent:main:subagent:abc"] = {
        sessionId: "child-session-steer",
        updatedAt: Date.now(),
      };
    });
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { store: storePath },
    } as OpenClawConfig;
    const params = buildParams("/steer 1 check timer.ts instead", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("steered");
    const steerWaitIndex = callGatewayMock.mock.calls.findIndex(
      (call) =>
        (call[0] as { method?: string; params?: { runId?: string } }).method === "agent.wait" &&
        (call[0] as { method?: string; params?: { runId?: string } }).params?.runId === "run-1",
    );
    expect(steerWaitIndex).toBeGreaterThanOrEqual(0);
    const steerRunIndex = callGatewayMock.mock.calls.findIndex(
      (call) => (call[0] as { method?: string }).method === "agent",
    );
    expect(steerRunIndex).toBeGreaterThan(steerWaitIndex);
    expect(callGatewayMock.mock.calls[steerWaitIndex]?.[0]).toMatchObject({
      method: "agent.wait",
      params: { runId: "run-1", timeoutMs: 5_000 },
      timeoutMs: 7_000,
    });
    expect(callGatewayMock.mock.calls[steerRunIndex]?.[0]).toMatchObject({
      method: "agent",
      params: {
        lane: "subagent",
        sessionKey: "agent:main:subagent:abc",
        sessionId: "child-session-steer",
        timeout: 0,
      },
    });
    const trackedRuns = listSubagentRunsForRequester("agent:main:main");
    expect(trackedRuns).toHaveLength(1);
    expect(trackedRuns[0].runId).toBe("run-steer-1");
    expect(trackedRuns[0].endedAt).toBeUndefined();
  });

  it("restores announce behavior when /steer replacement dispatch fails", async () => {
    resetSubagentRegistryForTests();
    callGatewayMock.mockReset();
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      if (request.method === "agent") {
        throw new Error("dispatch failed");
      }
      return {};
    });
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:abc",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      cleanup: "keep",
      createdAt: 1000,
      startedAt: 1000,
    });
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
    } as OpenClawConfig;
    const params = buildParams("/steer 1 check timer.ts instead", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("send failed: dispatch failed");

    const trackedRuns = listSubagentRunsForRequester("agent:main:main");
    expect(trackedRuns).toHaveLength(1);
    expect(trackedRuns[0].runId).toBe("run-1");
    expect(trackedRuns[0].suppressAnnounceReason).toBeUndefined();
  });
});

describe("handleCommands /tts", () => {
  it("returns status for bare /tts on text command surfaces", async () => {
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: { tts: { prefsPath: path.join(testWorkspaceDir, "tts.json") } },
    } as OpenClawConfig;
    const params = buildParams("/tts", cfg);
    const result = await handleCommands(params);
    expect(result.shouldContinue).toBe(false);
    expect(result.reply?.text).toContain("TTS status");
  });
});
