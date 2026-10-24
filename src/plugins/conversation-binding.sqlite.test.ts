import assert from "node:assert/strict";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  detachPluginConversationBinding as detach,
  getCurrentPluginConversationBinding as current,
  requestPluginConversationBinding as request,
  resolvePluginConversationBindingApproval as resolveApproval,
} from "./conversation-binding.js";
import { seedPluginConversationBindingApprovalForTest } from "./conversation-binding.test-fixtures.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "./runtime.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const channel = "binding-test";
function installGenericBindingChannel(): void {
  const plugin = {
    ...createChannelTestPluginBase({ id: channel }),
    conversationBindings: { supportsCurrentConversationBinding: true },
  };
  setActivePluginRegistry(createTestRegistry([{ pluginId: channel, source: "test", plugin }]));
}

async function closeState() {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}

async function approve(
  requested: Awaited<ReturnType<typeof request>>,
  decision: "allow-always" | "allow-once",
) {
  assert(requested.status === "pending", "Expected a plugin binding approval request");
  const choice = { approvalId: requested.approvalId, decision, senderId: "user-1" };
  await expect(resolveApproval(choice)).resolves.toMatchObject({ status: "approved" });
}

const tempDirs: string[] = [];
let restoreEnv: () => void;
let registrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;

beforeEach(async () => {
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  restoreEnv = () => envSnapshot.restore();
  registrySnapshot = captureActivePluginRegistrySnapshot();
  await drainGlobalSingletonLifecycleState();
  await closeState();
  setTestEnvValue("OPENCLAW_STATE_DIR", makeTrackedTempDir("plugin-binding-sqlite", tempDirs));
  installGenericBindingChannel();
});

afterEach(async () => {
  await drainGlobalSingletonLifecycleState();
  await closeState();
  restoreActivePluginRegistrySnapshot(registrySnapshot);
  restoreEnv();
  cleanupTrackedTempDirs(tempDirs);
});

it.each(["pending approval", "persistent approval"] as const)(
  "keeps an opaque target usable across restart after %s",
  async (approval) => {
    const owner = { pluginId: "fixture-runtime", pluginRoot: "/plugins/fixture-runtime" };
    const conversation = { channel, accountId: "default", conversationId: "room:shared" };
    const owned = { ...owner, conversation };
    const binding = { summary: "Continue", detachHint: "/detach", data: { externalThread: "17" } };
    const input = { ...owned, requestedBySenderId: "user-1", binding };
    const foreign = { pluginRoot: "/plugins/other-runtime", conversation };
    if (approval === "persistent approval") {
      await seedPluginConversationBindingApprovalForTest({ ...owner, ...conversation });
    }

    const service = getSessionBindingService();
    const requested = await request(input);
    if (approval === "pending approval") {
      expect(service.resolveByConversation(conversation)).toBeNull();
      await approve(requested, "allow-always");
    } else {
      expect(requested.status).toBe("bound");
    }

    const record = expectDefined(service.resolveByConversation(conversation), "approved binding");
    expect(record.targetSessionKey).toMatch(/^plugin-binding:fixture-runtime:/);
    expect(record.metadata).toMatchObject({ ...owner, ...input.binding });
    expect(service.listBySession(record.targetSessionKey)).toEqual([record]);

    const workConversation = { ...conversation, accountId: "work" };
    const workRequest = await request({ ...input, conversation: workConversation });
    expect(service.resolveByConversation(workConversation)).toBeNull();
    await approve(workRequest, "allow-once");
    const workRecord = expectDefined(service.resolveByConversation(workConversation), "work");
    expect(workRecord.targetSessionKey).not.toBe(record.targetSessionKey);

    await drainGlobalSingletonLifecycleState();
    await closeState();
    installGenericBindingChannel();

    await expect(current(owned)).resolves.toMatchObject({
      bindingId: record.bindingId,
      ...owner,
      ...conversation,
      ...input.binding,
    });
    expect(service.listBySession(record.targetSessionKey)).toEqual([record]);
    expect(service.listBySession(workRecord.targetSessionKey)).toEqual([workRecord]);
    const touchedAt = record.boundAt + 1_000;
    service.touch(record.bindingId, touchedAt, record.conversation);
    await closeState();
    expect(service.resolveByConversation(conversation)?.metadata).toMatchObject({
      ...record.metadata,
      lastActivityAt: touchedAt,
    });

    await expect(current(foreign)).resolves.toBeNull();
    await expect(detach(foreign)).resolves.toEqual({ removed: false });
    expect(service.listBySession(record.targetSessionKey)).toHaveLength(1);
    await expect(detach(owned)).resolves.toEqual({ removed: true });
    expect(service.resolveByConversation(conversation)).toBeNull();
    expect(service.listBySession(record.targetSessionKey)).toEqual([]);
    expect(service.resolveByConversation(workConversation)).toEqual(workRecord);

    await expect(
      service.unbind({ targetSessionKey: workRecord.targetSessionKey, reason: "session-ended" }),
    ).resolves.toEqual([workRecord]);
    await closeState();
    expect(service.resolveByConversation(workConversation)).toBeNull();
    expect(service.listBySession(workRecord.targetSessionKey)).toEqual([]);
  },
);
