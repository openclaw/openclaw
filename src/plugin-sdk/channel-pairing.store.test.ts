import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { afterEach, expect, it, vi } from "vitest";
import {
  approveChannelPairingCode,
  listChannelPairingRequests,
  readChannelAllowFromStore,
  removeChannelAllowFromStoreEntry,
  upsertChannelPairingRequest,
} from "../pairing/pairing-store.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createPluginRuntimeMock } from "./test-helpers/plugin-runtime-mock.js";

let stateDir: string;
afterEach(async () => {
  resetGlobalHookRunner();
  await closeStateDatabaseForTest();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function createPairingFixture() {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-scoped-pairing-"));
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const core = createPluginRuntimeMock({
    channel: {
      pairing: {
        upsertPairingRequest: (input) => upsertChannelPairingRequest({ ...input, env }),
        readAllowFromStore: ({ channel, accountId }) =>
          readChannelAllowFromStore(channel, env, accountId),
        removeAllowFromStoreEntry: (input) => removeChannelAllowFromStoreEntry({ ...input, env }),
      },
    },
  });
  return {
    env,
    pairing: createChannelPairingController({ core, channel: "demo", accountId: " Alpha " }),
    list: (channel = "demo", accountId = "alpha") =>
      listChannelPairingRequests(channel, env, accountId),
    approve: (code: string, accountId = "alpha") =>
      approveChannelPairingCode({ channel: "demo", accountId, code, env }),
  };
}

it("keeps the pairing lifecycle and hooks bound to one account despite replacement inputs", async () => {
  const { env, pairing, list, approve } = createPairingFixture();
  const handler = vi.fn(async () => {});
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "channel_pairing_requested", handler }]),
  );
  const beta = await upsertChannelPairingRequest({
    channel: "demo",
    accountId: "beta",
    id: "sender",
    meta: { name: "B" },
    env,
  });
  const request = { id: "sender", meta: { name: "A" }, channel: "other", accountId: "beta" };
  const replies: string[] = [];
  const challenge = {
    ...request,
    senderId: request.id,
    senderIdLine: "Sender: sender",
    sendPairingReply: async (text: string) => {
      replies.push(text);
    },
    upsertPairingRequest: () =>
      upsertChannelPairingRequest({ channel: "other", accountId: "beta", id: "replacement", env }),
  };
  const alpha = await pairing.issueChallenge(challenge);
  expect(alpha.created).toBe(true);
  assert(alpha.code);
  expect(alpha.code).not.toBe(beta.code);
  const hookScope = { accountId: "alpha", senderId: request.id };
  expect(handler).toHaveBeenCalledWith(
    expect.objectContaining({ channel: "demo", ...hookScope, code: alpha.code }),
    expect.objectContaining({ channelId: "demo", ...hookScope }),
  );
  expect(replies).toHaveLength(1);
  expect(replies[0]).toContain(`openclaw pairing approve demo ${alpha.code}`);
  await expect(pairing.upsertPairingRequest(request)).resolves.toEqual({
    code: alpha.code,
    created: false,
  });
  await expect(pairing.issueChallenge(challenge)).resolves.toEqual({ created: false });
  expect(replies).toHaveLength(1);
  await closeStateDatabaseForTest();
  await expect(list()).resolves.toMatchObject([
    { id: request.id, code: alpha.code, meta: { name: "A", accountId: "alpha" } },
  ]);
  await expect(list("demo", "beta")).resolves.toMatchObject([
    { code: beta.code, meta: { name: "B", accountId: "beta" } },
  ]);
  await expect(list("other", "beta")).resolves.toEqual([]);
  await expect(approve(alpha.code, "beta")).resolves.toBeNull();
  await expect(approve(alpha.code)).resolves.toMatchObject({ id: request.id });
  await expect(pairing.readAllowFromStore()).resolves.toEqual([request.id]);
  await expect(list()).resolves.toEqual([]);
  await expect(readChannelAllowFromStore("demo", env, "beta")).resolves.toEqual([]);
  await approve(beta.code, "beta");
  await expect(pairing.removeAllowFromStoreEntry(request.id)).resolves.toEqual({
    changed: true,
    allowFrom: [],
  });
  await expect(pairing.readAllowFromStore()).resolves.toEqual([]);
  await expect(pairing.readStoreForDmPolicy("demo", " Beta ")).resolves.toEqual([request.id]);
});
