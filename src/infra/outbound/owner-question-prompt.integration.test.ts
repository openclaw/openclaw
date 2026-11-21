/**
 * An owner-routed question prompt runs through real durable delivery, and a
 * change while delivery prepares the send stops it before the channel adapter.
 */
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentHarnessUserInputQuestion } from "../../agents/harness/user-input-types.js";
import {
  publishOwnerQuestionPrompt,
  sendQuestionToolPrompt,
} from "../../agents/tools/question-prompt-send.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { matrixDeliveryResult as textReceipt } from "./deliver.custody.test-support.js";
import { installDeliveryQueueTmpDirHooks } from "./delivery-queue.test-helpers.js";
import { createGenericTargetTestPlugin } from "./targets.test-helpers.js";

const fixtures = installDeliveryQueueTmpDirHooks();
const registrySnapshot = captureActivePluginRegistrySnapshot();
const ownerConfig = (owner: string): OpenClawConfig => ({
  commands: { ownerAllowFrom: [`alpha:user:${owner}`] },
  channels: { alpha: {} },
  gateway: { publicOrigin: "https://ops.example.test" },
});
const question: AgentHarnessUserInputQuestion = {
  id: "approval",
  header: "Approval",
  question: "May Bob book Thursday?",
  isOther: true,
  isSecret: false,
  options: [{ label: "Approve" }, { label: "Decline" }],
};

afterEach(() => {
  clearRuntimeConfigSnapshot();
  restoreActivePluginRegistrySnapshot(registrySnapshot);
});

/** Installs the owner's channel with a send whose preparation waits on `held`. */
function installOwnerChannel(held: Promise<void>) {
  const sent: string[] = [];
  const preparing = createDeferred();
  const base = createGenericTargetTestPlugin("alpha");
  const plugin: ChannelPlugin = {
    ...base,
    agentPrompt: { questionInputMode: "buttons" },
    message: {
      id: "alpha",
      durableFinal: { capabilities: { text: true } },
      send: {
        lifecycle: {
          beforeSendAttempt: async () => {
            preparing.resolve();
            await held;
          },
        },
        text: async ({ to, onPlatformSendDispatch }) => {
          await onPlatformSendDispatch?.();
          sent.push(to);
          return textReceipt("owner-prompt");
        },
      },
    },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "alpha", plugin, source: "test" }]));
  return { sent, preparing: preparing.promise };
}

it("sends an owner-routed question to the owner through durable delivery", async () => {
  process.env.OPENCLAW_STATE_DIR = fixtures.tmpDir();
  setRuntimeConfigSnapshot(ownerConfig("alice"));
  const channel = installOwnerChannel(Promise.resolve());

  await publishOwnerQuestionPrompt({ questionId: "ask_owner_sent", questions: [question] });

  expect(channel.sent).toEqual([expect.stringMatching(/user:alice$/)]);
});

it("never reaches the former owner when the owner is replaced while delivery prepares", async () => {
  process.env.OPENCLAW_STATE_DIR = fixtures.tmpDir();
  setRuntimeConfigSnapshot(ownerConfig("alice"));
  const release = createDeferred();
  const channel = installOwnerChannel(release.promise);

  const publishing = publishOwnerQuestionPrompt({
    questionId: "ask_owner_replaced",
    questions: [question],
  });
  await channel.preparing;
  setRuntimeConfigSnapshot(ownerConfig("bob"));
  release.resolve();

  await expect(publishing).rejects.toThrow();
  expect(channel.sent).toEqual([]);
});

it("never sends a question that ended while delivery prepared", async () => {
  process.env.OPENCLAW_STATE_DIR = fixtures.tmpDir();
  setRuntimeConfigSnapshot(ownerConfig("alice"));
  const release = createDeferred();
  const channel = installOwnerChannel(release.promise);
  let current = true;

  const publishing = publishOwnerQuestionPrompt({
    questionId: "ask_owner_ended",
    questions: [question],
    isCurrent: async () => current,
  });
  await channel.preparing;
  current = false;
  release.resolve();

  await expect(publishing).rejects.toThrow();
  expect(channel.sent).toEqual([]);
});

it("never sends an owner-routed credential request to an owner replaced while delivery prepares", async () => {
  process.env.OPENCLAW_STATE_DIR = fixtures.tmpDir();
  const cfg = ownerConfig("alice");
  setRuntimeConfigSnapshot(cfg);
  const release = createDeferred();
  const channel = installOwnerChannel(release.promise);

  const publishing = sendQuestionToolPrompt({
    toolName: "secrets",
    questionId: "ask_owner_secret",
    questions: [
      {
        questionId: "api_key",
        header: "API key",
        question: "Provide the deployment API key",
        options: [],
        isSecret: true,
        secretStore: {
          name: "DEPLOY_API_KEY",
          kind: "secret",
          allowedHosts: ["api.example.test"],
          reason: "Deploy the service",
        },
      },
    ],
    config: cfg,
    delivery: { audience: "owner" },
  });
  await channel.preparing;
  setRuntimeConfigSnapshot(ownerConfig("bob"));
  release.resolve();

  await expect(publishing).rejects.toThrow();
  expect(channel.sent).toEqual([]);
});
