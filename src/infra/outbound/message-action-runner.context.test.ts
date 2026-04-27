import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";
import {
  directChatConfig,
  directChatTestPlugin,
  directOutbound,
  forumTestPlugin,
  runDryAction,
  runDrySend,
  workspaceConfig,
  workspaceTestPlugin,
} from "./message-action-runner.test-helpers.js";

const localChatTestPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "localchat",
    label: "Local Chat",
    docsPath: "/channels/localchat",
    capabilities: { chatTypes: ["direct", "group"], media: true },
  }),
  meta: {
    id: "localchat",
    label: "Local Chat",
    selectionLabel: "Local Chat (local)",
    docsPath: "/channels/localchat",
    blurb: "Local chat test stub.",
    aliases: ["local"],
  },
  outbound: directOutbound,
  messaging: {
    normalizeTarget: (raw) => raw.trim() || undefined,
    targetResolver: {
      looksLikeId: (raw) => raw.trim().length > 0,
      hint: "<handle|chat_id:ID>",
    },
  },
};

describe("runMessageAction context isolation", () => {
  const tempRoots: string[] = [];

  function createSessionStore(entries: Record<string, Record<string, unknown>>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-msg-action-store-"));
    tempRoots.push(dir);
    const storePath = path.join(dir, "sessions.json");
    fs.writeFileSync(storePath, JSON.stringify(entries), "utf-8");
    return storePath;
  }

  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "workspace",
          source: "test",
          plugin: workspaceTestPlugin,
        },
        {
          pluginId: "directchat",
          source: "test",
          plugin: directChatTestPlugin,
        },
        {
          pluginId: "forum",
          source: "test",
          plugin: forumTestPlugin,
        },
        {
          pluginId: "localchat",
          source: "test",
          plugin: localChatTestPlugin,
        },
      ]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    for (const root of tempRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "allows send when target matches current channel",
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678" },
    },
    {
      name: "accepts legacy to parameter for send",
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        to: "#C12345678",
        message: "hi",
      },
    },
    {
      name: "defaults to current channel when target is omitted",
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678" },
    },
    {
      name: "allows media-only send when target matches current channel",
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        media: "https://example.com/note.ogg",
      },
      toolContext: { currentChannelId: "C12345678" },
    },
    {
      name: "allows send when poll booleans are explicitly false",
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        target: "#C12345678",
        message: "hi",
        pollMulti: false,
        pollAnonymous: false,
        pollPublic: false,
      },
      toolContext: { currentChannelId: "C12345678" },
    },
  ])("$name", async ({ cfg, actionParams, toolContext }) => {
    const result = await runDrySend({
      cfg,
      actionParams,
      ...(toolContext ? { toolContext } : {}),
    });

    expect(result.kind).toBe("send");
  });

  it.each([
    {
      name: "send when target differs from current workspace channel",
      run: () =>
        runDrySend({
          cfg: workspaceConfig,
          actionParams: {
            channel: "workspace",
            target: "channel:C99999999",
            message: "hi",
          },
          toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
        }),
      expectedKind: "send",
    },
    {
      name: "thread-reply when channelId differs from current workspace channel",
      run: () =>
        runDryAction({
          cfg: workspaceConfig,
          action: "thread-reply",
          actionParams: {
            channel: "workspace",
            target: "C99999999",
            message: "hi",
          },
          toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
        }),
      expectedKind: "action",
    },
  ])("blocks cross-context UI handoff for $name", async ({ run, expectedKind }) => {
    const result = await run();
    expect(result.kind).toBe(expectedKind);
  });

  it.each([
    {
      name: "direct chat match",
      channel: "directchat",
      target: "123@g.us",
      currentChannelId: "123@g.us",
    },
    {
      name: "local chat match",
      channel: "localchat",
      target: "localchat:+15551234567",
      currentChannelId: "localchat:+15551234567",
    },
    {
      name: "direct chat mismatch",
      channel: "directchat",
      target: "456@g.us",
      currentChannelId: "123@g.us",
      currentChannelProvider: "directchat",
    },
    {
      name: "local chat mismatch",
      channel: "localchat",
      target: "localchat:+15551230000",
      currentChannelId: "localchat:+15551234567",
      currentChannelProvider: "localchat",
    },
  ] as const)("$name", async (testCase) => {
    const result = await runDrySend({
      cfg: directChatConfig,
      actionParams: {
        channel: testCase.channel,
        target: testCase.target,
        message: "hi",
      },
      toolContext: {
        currentChannelId: testCase.currentChannelId,
        ...(testCase.currentChannelProvider
          ? { currentChannelProvider: testCase.currentChannelProvider }
          : {}),
      },
    });

    expect(result.kind).toBe("send");
  });

  it.each([
    {
      name: "infers channel + target from tool context when missing",
      cfg: {
        channels: {
          workspace: {
            botToken: "workspace-test",
            appToken: "workspace-app-test",
          },
          forum: {
            token: "forum-test",
          },
        },
      } as OpenClawConfig,
      action: "send" as const,
      actionParams: {
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
      expectedKind: "send",
      expectedChannel: "workspace",
    },
    {
      name: "falls back to tool-context provider when channel param is an id",
      cfg: workspaceConfig,
      action: "send" as const,
      actionParams: {
        channel: "C12345678",
        target: "#C12345678",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
      expectedKind: "send",
      expectedChannel: "workspace",
    },
    {
      name: "falls back to tool-context provider for broadcast channel ids",
      cfg: workspaceConfig,
      action: "broadcast" as const,
      actionParams: {
        targets: ["channel:C12345678"],
        channel: "C12345678",
        message: "hi",
      },
      toolContext: { currentChannelProvider: "workspace" },
      expectedKind: "broadcast",
      expectedChannel: "workspace",
    },
  ])("$name", async ({ cfg, action, actionParams, toolContext, expectedKind, expectedChannel }) => {
    const result = await runDryAction({
      cfg,
      action,
      actionParams,
      toolContext,
    });

    expect(result.kind).toBe(expectedKind);
    expect(result.channel).toBe(expectedChannel);
  });

  it.each([
    {
      name: "blocks cross-provider sends by default",
      action: "send" as const,
      cfg: workspaceConfig,
      actionParams: {
        channel: "forum",
        target: "@opsbot",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
      message: /Cross-context messaging denied/,
    },
    {
      name: "blocks same-provider cross-context when disabled",
      action: "send" as const,
      cfg: {
        ...workspaceConfig,
        tools: {
          message: {
            crossContext: {
              allowWithinProvider: false,
            },
          },
        },
      } as OpenClawConfig,
      actionParams: {
        channel: "workspace",
        target: "channel:C99999999",
        message: "hi",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
      message: /Cross-context messaging denied/,
    },
    {
      name: "blocks same-provider cross-context uploads when disabled",
      action: "upload-file" as const,
      cfg: {
        ...workspaceConfig,
        tools: {
          message: {
            crossContext: {
              allowWithinProvider: false,
            },
          },
        },
      } as OpenClawConfig,
      actionParams: {
        channel: "workspace",
        target: "channel:C99999999",
        filePath: "/tmp/report.png",
      },
      toolContext: { currentChannelId: "C12345678", currentChannelProvider: "workspace" },
      message: /Cross-context messaging denied/,
    },
    {
      name: "rejects channel ids that resolve to user targets",
      action: "channel-info" as const,
      cfg: workspaceConfig,
      actionParams: {
        channel: "workspace",
        channelId: "U12345678",
      },
      message: 'Channel id "U12345678" resolved to a user target.',
    },
  ])("$name", async ({ action, cfg, actionParams, toolContext, message }) => {
    await expect(
      runDryAction({
        cfg,
        action,
        actionParams,
        toolContext,
      }),
    ).rejects.toThrow(message);
  });

  it("blocks agent-originated sends into another local agent's bound channel", async () => {
    const storePath = createSessionStore({
      "agent:gpod:workspace:channel:c99999999": {
        sessionId: "sess-gpod",
        updatedAt: 100,
        deliveryContext: {
          channel: "workspace",
          to: "channel:C99999999",
        },
      },
    });

    await expect(
      runMessageAction({
        cfg: {
          ...workspaceConfig,
          session: {
            store: storePath,
          },
        } as OpenClawConfig,
        action: "send",
        params: {
          channel: "workspace",
          target: "channel:C99999999",
          message: "hi",
        },
        dryRun: true,
        agentId: "dev-agent",
      }),
    ).rejects.toThrow(/Use sessions_send with agentId="gpod"/i);
  });

  it("allows agent-originated sends into its own bound channel", async () => {
    const storePath = createSessionStore({
      "agent:gpod:workspace:channel:c99999999": {
        sessionId: "sess-gpod",
        updatedAt: 100,
        deliveryContext: {
          channel: "workspace",
          to: "channel:C99999999",
        },
      },
    });

    const result = await runMessageAction({
      cfg: {
        ...workspaceConfig,
        session: {
          store: storePath,
        },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "workspace",
        target: "channel:C99999999",
        message: "hi",
      },
      dryRun: true,
      agentId: "gpod",
    });

    expect(result.kind).toBe("send");
  });

  it("does not block non-agent operator sends into a bound channel", async () => {
    const storePath = createSessionStore({
      "agent:gpod:workspace:channel:c99999999": {
        sessionId: "sess-gpod",
        updatedAt: 100,
        deliveryContext: {
          channel: "workspace",
          to: "channel:C99999999",
        },
      },
    });

    const result = await runMessageAction({
      cfg: {
        ...workspaceConfig,
        session: {
          store: storePath,
        },
      } as OpenClawConfig,
      action: "send",
      params: {
        channel: "workspace",
        target: "channel:C99999999",
        message: "hi",
      },
      dryRun: true,
    });

    expect(result.kind).toBe("send");
  });

  it.each([
    {
      name: "send",
      run: (abortSignal: AbortSignal) =>
        runDrySend({
          cfg: workspaceConfig,
          actionParams: {
            channel: "workspace",
            target: "#C12345678",
            message: "hi",
          },
          abortSignal,
        }),
    },
    {
      name: "broadcast",
      run: (abortSignal: AbortSignal) =>
        runDryAction({
          cfg: workspaceConfig,
          action: "broadcast",
          actionParams: {
            targets: ["channel:C12345678"],
            channel: "workspace",
            message: "hi",
          },
          abortSignal,
        }),
    },
  ])("aborts $name when abortSignal is already aborted", async ({ run }) => {
    const controller = new AbortController();
    controller.abort();
    await expect(run(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
