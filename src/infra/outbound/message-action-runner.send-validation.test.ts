import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  forumTestPlugin,
  runDrySend,
  workspaceConfig,
  workspaceTestPlugin,
} from "./message-action-runner.test-helpers.js";

// Spy on executeSendAction to capture the final message text that reaches the send layer.
// Called through to the real implementation so all other test behaviour is unchanged.
let _lastSendMessage: string | undefined;
vi.mock("./outbound-send-service.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./outbound-send-service.js")>();
  return {
    ...real,
    executeSendAction: vi.fn(async (...args: Parameters<typeof real.executeSendAction>) => {
      _lastSendMessage = args[0].message;
      return real.executeSendAction(...args);
    }),
  };
});

describe("runMessageAction send validation", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: workspaceTestPlugin,
        },
        {
          pluginId: "forum",
          source: "test",
          plugin: forumTestPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("requires message when no media hint is provided", async () => {
    await expect(
      runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "#C12345678",
        },
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/message required/i);
  });

  it("allows send when only presentation payloads are provided", async () => {
    const result = await runDrySend({
      cfg: {
        channels: {
          forum: {
            botToken: "forum-test",
          },
        },
      } as OpenClawConfig,
      actionParams: {
        channel: "forum",
        target: "123456",
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Approve", value: "approve" }],
            },
          ],
        },
      },
    });

    expect(result.kind).toBe("send");
  });

  it("allows send when only generic presentation blocks are provided", async () => {
    const result = await runDrySend({
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        presentation: { blocks: [{ type: "divider" }] },
      },
      toolContext: { currentChannelId: "C12345678" },
    });

    expect(result.kind).toBe("send");
  });

  it.each([
    {
      name: "structured poll params",
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        pollQuestion: "Ready?",
        pollOption: ["Yes", "No"],
      },
    },
    {
      name: "string-encoded poll params",
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        pollDurationSeconds: "60",
        pollPublic: "true",
      },
    },
    {
      name: "snake_case poll params",
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        poll_question: "Ready?",
        poll_option: ["Yes", "No"],
        poll_public: "true",
      },
    },
    {
      name: "negative poll duration params",
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        pollDurationSeconds: -5,
      },
    },
  ])("rejects send actions that include $name", async ({ actionParams }) => {
    await expect(
      runDrySend({
        cfg: workspaceConfig,
        actionParams,
        toolContext: { currentChannelId: "C12345678" },
      }),
    ).rejects.toThrow(/use action "poll" instead of "send"/i);
  });
});

describe("runMessageAction send --message-file", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-msg-file-test-"));
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "workspace", source: "test", plugin: workspaceTestPlugin }]),
    );
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    setActivePluginRegistry(createTestRegistry([]));
  });

  it("reads message body from file", async () => {
    const filePath = path.join(tmpDir, "msg.txt");
    await fs.writeFile(filePath, "hello from file", "utf8");
    const result = await runDrySend({
      cfg: workspaceConfig,
      actionParams: { channel: "workspace", target: "#C12345678", messageFile: filePath },
    });
    expect(result.kind).toBe("send");
  });

  it("preserves file content exactly — no trim and no literal-backslash-n expansion", async () => {
    _lastSendMessage = undefined;
    const filePath = path.join(tmpDir, "report.txt");
    // Leading spaces prove no trimming; literal \n (backslash+n) proves no \\n→\n expansion.
    // Inline --message would both trim and expand these, corrupting JSON or indented content.
    await fs.writeFile(filePath, "  hello\\nworld", "utf8");
    const result = await runDrySend({
      cfg: workspaceConfig,
      actionParams: { channel: "workspace", target: "#C12345678", messageFile: filePath },
    });
    expect(result.kind).toBe("send");
    expect(_lastSendMessage).toContain("  hello");
    expect(_lastSendMessage).toContain("hello\\nworld");
    expect(_lastSendMessage).not.toContain("hello\nworld");
  });

  it("rejects when both --message and --message-file are provided", async () => {
    const filePath = path.join(tmpDir, "msg.txt");
    await fs.writeFile(filePath, "from file", "utf8");
    await expect(
      runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "#C12345678",
          message: "inline",
          messageFile: filePath,
        },
      }),
    ).rejects.toThrow(/use --message or --message-file, not both/i);
  });

  it("rejects when --message-file is combined with an empty --message", async () => {
    const filePath = path.join(tmpDir, "msg.txt");
    await fs.writeFile(filePath, "from file", "utf8");
    await expect(
      runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "#C12345678",
          message: "",
          messageFile: filePath,
        },
      }),
    ).rejects.toThrow(/use --message or --message-file, not both/i);
  });

  it("throws a clear error when the file does not exist", async () => {
    await expect(
      runDrySend({
        cfg: workspaceConfig,
        actionParams: {
          channel: "workspace",
          target: "#C12345678",
          messageFile: path.join(tmpDir, "nonexistent.txt"),
        },
      }),
    ).rejects.toThrow(/message file not found/i);
  });

  it("satisfies the message-required check so --media is not needed", async () => {
    const filePath = path.join(tmpDir, "msg.txt");
    await fs.writeFile(filePath, "content", "utf8");
    await expect(
      runDrySend({
        cfg: workspaceConfig,
        actionParams: { channel: "workspace", target: "#C12345678", messageFile: filePath },
      }),
    ).resolves.not.toThrow();
  });
});
