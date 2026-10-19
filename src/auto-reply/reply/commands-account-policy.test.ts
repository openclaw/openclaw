import { beforeEach, expect, it } from "vitest";
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
import { buildCommandContextForTest as buildCommandContext } from "./commands-context.test-support.js";
import { handleCommands } from "./commands-core.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { resolveAuthorizedSessionResetCommand } from "./session-reset-command.js";

const channel = "account-policy-chat";
const accountKeyPolicy = { canonicalAliasesRequireOwnField: "account" };

type AccountConfig = { account?: string; allowFrom: string[] };
const account = (sender = "bob", eligible = false): AccountConfig => ({
  allowFrom: [sender],
  ...(eligible ? { account: "+12025550124" } : {}),
});
const eligibleAccounts = { "Work Phone": account("bob", true) };
const priorityAccounts = (key: string) => ({
  "Work Phone": account("alice", true),
  [key]: account(),
});

beforeEach(({ onTestFinished }) => {
  const previous = captureActivePluginRegistrySnapshot();
  onTestFinished(() => rollbackStagedPluginRegistry(previous));
  const plugin = {
    ...createChannelTestPluginBase({
      id: channel,
      capabilities: { chatTypes: ["direct", "group"] },
    }),
    commands: { enforceOwnerForCommands: true },
  };
  const registry = createTestRegistry([
    { pluginId: channel, source: `/tmp/${channel}/index.js`, plugin },
  ]);
  stageActivePluginRegistry(registry, null, "default");
});

async function dispatch(params: {
  accounts?: Record<string, AccountConfig>;
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
        accounts: params.accounts ?? { "Work Phone": account() },
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
      const group = { cfg, isGroup: true, commandAuthorized: true };
      commandParams.command = buildCommandContext({
        ...group,
        ctx: commandParams.ctx,
        triggerBodyNormalized: "/acp help",
      });
      const result = await handleCommands({
        ...commandParams,
        resolveModelLevels: async () => ({
          resolvedThinkLevel: undefined,
          resolvedReasoningLevel: "off",
        }),
      });
      const reset = await resolveAuthorizedSessionResetCommand({
        ...group,
        ctx: { ...commandParams.ctx, commandText: "/reset", rawText: "/reset" },
        agentId: "main",
      });
      return { result, command: commandParams.command, reset };
    },
    { config: cfg },
  );
}

type PolicyCase = Omit<Parameters<typeof dispatch>[0], "sender"> & {
  name: string;
  senders?: string[];
  allowed?: string;
};

it.each<PolicyCase>([
  ...[undefined, "work-phone"].map((defaultAccount) => ({
    name: `ignored alias, default=${defaultAccount}`,
    accountId: "work-phone",
    defaultAccount,
    allowed: "alice",
  })),
  { name: "eligible sole alias", accounts: eligibleAccounts },
  { name: "eligible configured default", accounts: eligibleAccounts, defaultAccount: "work-phone" },
  { name: "undeclared channel singleton", declaresPolicy: false },
  { name: "exact key", accounts: priorityAccounts("work-phone"), accountId: "work-phone" },
  { name: "case-only key", accounts: priorityAccounts("WORK-PHONE"), accountId: "work-phone" },
  ...["alice", "bob", "owner"].map((sender) => ({
    name: `global owner: ${sender}`,
    accountId: "work-phone",
    ownerAllowFrom: ["owner"],
    senders: [sender],
    allowed: "owner",
  })),
])("access: $name", async ({ senders = ["alice", "bob"], allowed = "bob", ...params }) => {
  for (const sender of senders) {
    const actual = await dispatch({ ...params, sender });
    const authorized = sender === allowed;
    expect(actual.command.senderIsOwner).toBe(sender === "owner");
    if (!authorized) {
      expect.soft(actual.result).toEqual({ shouldContinue: false });
    }
    expect.soft(actual).toMatchObject({
      result: authorized
        ? { shouldContinue: false, reply: { text: expect.stringContaining("/acp spawn") } }
        : { shouldContinue: false },
      command: { isAuthorizedSender: authorized },
      reset: {
        resetAuthorized: authorized,
        resetCommand: { matchedResetTriggerLower: authorized ? "/reset" : undefined },
      },
    });
  }
});
