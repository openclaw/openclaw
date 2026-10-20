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
  detachPluginConversationBinding,
  getCurrentPluginConversationBinding,
  requestPluginConversationBinding,
  resolvePluginConversationBindingApproval,
} from "./conversation-binding.js";
import { seedPluginConversationBindingApprovalForTest } from "./conversation-binding.test-fixtures.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "./runtime.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

function installGenericBindingChannel(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "binding-test",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "binding-test" }),
          conversationBindings: { supportsCurrentConversationBinding: true },
        },
      },
    ]),
  );
}

async function closeState() {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}

async function approve(
  request: Awaited<ReturnType<typeof requestPluginConversationBinding>>,
  decision: "allow-always" | "allow-once",
) {
  assert(request.status === "pending", "Expected a plugin binding approval request");
  await expect(
    resolvePluginConversationBindingApproval({
      approvalId: request.approvalId,
      decision,
      senderId: "user-1",
    }),
  ).resolves.toMatchObject({ status: "approved" });
}

const tempDirs: string[] = [];
let restoreEnv: () => void;
let registrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;

beforeEach(async () => {
  restoreEnv = captureEnv(["OPENCLAW_STATE_DIR"]).restore;
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
    const conversation = {
      channel: "binding-test",
      accountId: "default",
      conversationId: "room:shared",
    };
    const input = {
      ...owner,
      conversation,
      requestedBySenderId: "user-1",
      binding: {
        summary: "Continue the plugin conversation",
        detachHint: "/detach",
        data: { externalThread: "thread-17" },
      },
    };
    const owned = { ...owner, conversation };
    const foreign = { pluginRoot: "/plugins/other-runtime", conversation };
    if (approval === "persistent approval") {
      await seedPluginConversationBindingApprovalForTest({ ...owner, ...conversation });
    }

    const service = getSessionBindingService();
    const requested = await requestPluginConversationBinding(input);
    if (approval === "pending approval") {
      expect(service.resolveByConversation(conversation)).toBeNull();
      await approve(requested, "allow-always");
    } else {
      expect(requested.status).toBe("bound");
    }

    const record = expectDefined(
      service.resolveByConversation(conversation),
      "approved plugin binding persisted",
    );
    expect(record.targetSessionKey).toMatch(/^plugin-binding:fixture-runtime:/);
    expect(record.metadata).toMatchObject({ ...owner, ...input.binding });
    expect(service.listBySession(record.targetSessionKey)).toEqual([record]);

    const workConversation = { ...conversation, accountId: "work" };
    const workRequest = await requestPluginConversationBinding({
      ...input,
      conversation: workConversation,
    });
    expect(service.resolveByConversation(workConversation)).toBeNull();
    await approve(workRequest, "allow-once");
    const workRecord = expectDefined(
      service.resolveByConversation(workConversation),
      "separate account binding persisted",
    );
    expect(workRecord.targetSessionKey).not.toBe(record.targetSessionKey);

    await drainGlobalSingletonLifecycleState();
    await closeState();
    installGenericBindingChannel();

    await expect(getCurrentPluginConversationBinding(owned)).resolves.toMatchObject({
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

    await expect(getCurrentPluginConversationBinding(foreign)).resolves.toBeNull();
    await expect(detachPluginConversationBinding(foreign)).resolves.toEqual({ removed: false });
    expect(service.listBySession(record.targetSessionKey)).toHaveLength(1);
    await expect(detachPluginConversationBinding(owned)).resolves.toEqual({
      removed: true,
    });
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
