import { beforeEach, describe, expect, it } from "vitest";
import { getLoadedChannelPluginById } from "../../channels/plugins/registry-loaded.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { buildCommandContext } from "./commands-context.js";
import { handleCommands } from "./commands-core.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { resolveAuthorizedSessionResetCommand } from "./session-reset-command.js";

const channel = "account-policy-chat";
const accountKeyPolicy = { canonicalAliasesRequireOwnField: "account" };

type AccountConfig = { account?: string; allowFrom: string[] };

beforeEach(({ onTestFinished }) => {
  const previous = captureActivePluginRegistrySnapshot();
  onTestFinished(() => {
    rollbackStagedPluginRegistry(previous);
  });
  stageActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: channel,
        source: `/tmp/${channel}/index.js`,
        plugin: {
          ...createChannelTestPluginBase({
            id: channel,
            capabilities: { chatTypes: ["direct", "group"] },
          }),
          commands: { enforceOwnerForCommands: true },
        },
      },
    ]),
    null,
    "default",
  );
  const plugin = getLoadedChannelPluginById(channel);
  expect(plugin).toBeDefined();
  expect(plugin?.config.resolveAllowFrom).toBeUndefined();
});

async function dispatch(params: {
  accounts: Record<string, AccountConfig>;
  defaultAccount?: string;
  accountId?: string;
  sender: string;
  declaresPolicy?: boolean;
  ownerAllowFrom?: string[];
}) {
  const cfg: OpenClawConfig = {
    commands: { text: true, ownerAllowFrom: params.ownerAllowFrom },
    channels: {
      [channel]: {
        account: "+12025550123",
        allowFrom: ["alice"],
        defaultAccount: params.defaultAccount,
        accounts: params.accounts,
      },
    },
  };
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: channel,
        channels: [channel],
        ...(params.declaresPolicy === false
          ? {}
          : { channelAccountKeyPolicies: { [channel]: accountKeyPolicy } }),
      },
    ],
  });
  return withPluginMetadataSnapshotScope(
    metadata,
    async () => {
      const commandParams = buildCommandTestParams("/acp help", cfg, {
        Provider: channel,
        Surface: channel,
        AccountId: params.accountId,
        SenderId: params.sender,
        From: `${channel}:group:room`,
        ChatType: "group",
      });
      commandParams.isGroup = true;
      commandParams.command = buildCommandContext({
        ctx: commandParams.ctx,
        cfg,
        isGroup: true,
        triggerBodyNormalized: "/acp help",
        commandAuthorized: true,
      });
      const result = await handleCommands({
        ...commandParams,
        resolveModelLevels: async () => ({
          resolvedThinkLevel: undefined,
          resolvedReasoningLevel: "off",
        }),
      });
      const reset = resolveAuthorizedSessionResetCommand({
        cfg,
        ctx: { ...commandParams.ctx, commandText: "/reset", rawText: "/reset" },
        agentId: "main",
        isGroup: true,
        commandAuthorized: true,
      });
      return { result, command: commandParams.command, reset };
    },
    { config: cfg },
  );
}

function expectAccess(
  actual: Awaited<ReturnType<typeof dispatch>>,
  authorized: boolean,
  owner = false,
) {
  expect(actual.command.senderIsOwner).toBe(owner);
  if (authorized) {
    expect.soft(actual.result).toMatchObject({
      shouldContinue: false,
      reply: { text: expect.stringContaining("/acp spawn") },
    });
  } else {
    expect.soft(actual.result).toEqual({ shouldContinue: false });
  }
  expect.soft(actual.command.isAuthorizedSender).toBe(authorized);
  expect.soft(actual.reset.resetAuthorized).toBe(authorized);
  expect
    .soft(actual.reset.resetCommand.matchedResetTriggerLower)
    .toBe(authorized ? "/reset" : undefined);
}

describe("handleCommands and session reset account-policy authorization for admitted groups", () => {
  it.each(
    [undefined, "work-phone"].flatMap((defaultAccount) =>
      ["alice", "bob"].map((sender) => ({ defaultAccount, sender })),
    ),
  )(
    "uses root access for an ignored alias: sender=$sender, default=$defaultAccount",
    async ({ defaultAccount, sender }) => {
      const actual = await dispatch({
        accounts: { "Work Phone": { allowFrom: ["bob"] } },
        accountId: "work-phone",
        defaultAccount,
        sender,
      });
      expectAccess(actual, sender === "alice");
    },
  );

  it.each<
    Omit<Parameters<typeof dispatch>[0], "sender"> & {
      name: string;
    }
  >([
    {
      name: "eligible sole alias",
      accounts: { "Work Phone": { account: "+12025550124", allowFrom: ["bob"] } },
    },
    {
      name: "eligible configured default",
      accounts: { "Work Phone": { account: "+12025550124", allowFrom: ["bob"] } },
      defaultAccount: "work-phone",
    },
    {
      name: "undeclared channel singleton",
      accounts: { "Work Phone": { allowFrom: ["bob"] } },
      declaresPolicy: false,
    },
    {
      name: "exact key wins over an eligible alias",
      accounts: {
        "Work Phone": { account: "+12025550124", allowFrom: ["alice"] },
        "work-phone": { allowFrom: ["bob"] },
      },
      accountId: "work-phone",
    },
    {
      name: "case-only key wins over an eligible alias",
      accounts: {
        "Work Phone": { account: "+12025550124", allowFrom: ["alice"] },
        "WORK-PHONE": { allowFrom: ["bob"] },
      },
      accountId: "work-phone",
    },
  ])("preserves $name command and reset access", async (testCase) => {
    for (const sender of ["alice", "bob"]) {
      const actual = await dispatch({ ...testCase, sender });
      expectAccess(actual, sender === "bob");
    }
  });

  it.each(["alice", "bob", "owner"])(
    "keeps explicit global owner authority separate: %s",
    async (sender) => {
      const actual = await dispatch({
        accounts: { "Work Phone": { allowFrom: ["bob"] } },
        accountId: "work-phone",
        ownerAllowFrom: ["owner"],
        sender,
      });
      expectAccess(actual, sender === "owner", sender === "owner");
    },
  );
});
