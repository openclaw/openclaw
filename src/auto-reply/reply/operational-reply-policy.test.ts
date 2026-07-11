// Tests operational reply delivery policy state and durable once-key behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";
import { markReplyPayloadForSourceSuppressionDelivery } from "../reply-payload.js";
import {
  applyOperationalReplyPolicy,
  clearOperationalReplyPolicyStateForTest,
  markOperationalReplyPolicyDelivered,
} from "./operational-reply-policy.js";

const tempDirs: string[] = [];

async function createSessionStoreFixture(params?: { operationalReplyOnceKeys?: string[] }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-operational-reply-policy-"));
  tempDirs.push(root);
  const storePath = path.join(root, "sessions.json");
  const sessionKey = "agent:main:visiblechat:direct:user";
  const entry: SessionEntry = {
    sessionId: "s1",
    updatedAt: Date.now(),
    ...(params?.operationalReplyOnceKeys
      ? { operationalReplyOnceKeys: params.operationalReplyOnceKeys }
      : {}),
  };
  await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: entry }, null, 2), "utf8");
  return { sessionKey, storePath };
}

function onceConfig(storePath?: string): OpenClawConfig {
  return {
    ...(storePath ? { session: { store: storePath } } : {}),
    messages: { operationalReplies: { policy: "once" } },
  } as OpenClawConfig;
}

function applyOncePolicy(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  storePath?: string;
  text: string;
}) {
  return applyOperationalReplyPolicy({
    cfg: params.cfg,
    payload: markReplyPayloadForSourceSuppressionDelivery({
      text: params.text,
      isError: true,
    }),
    explicitCommandTurn: false,
    sendPolicyDenied: false,
    sourceSessionKey: params.sessionKey,
    sourceStorePath: params.storePath,
    sourceEventKey: "event-1",
    sourceChannel: "visiblechat",
  });
}

describe("operational reply policy", () => {
  beforeEach(() => {
    clearOperationalReplyPolicyStateForTest();
  });

  afterEach(async () => {
    clearOperationalReplyPolicyStateForTest();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("reserves once keys before delivery and releases failed deliveries", async () => {
    const { sessionKey, storePath } = await createSessionStoreFixture();
    const cfg = onceConfig(storePath);

    const first = await applyOncePolicy({
      cfg,
      sessionKey,
      storePath,
      text: "backend failed",
    });
    const duplicateWhilePending = await applyOncePolicy({
      cfg,
      sessionKey,
      storePath,
      text: "backend failed",
    });

    expect(first.shouldDeliver).toBe(true);
    expect(duplicateWhilePending.shouldDeliver).toBe(false);

    await markOperationalReplyPolicyDelivered(first, false);

    const retryAfterFailure = await applyOncePolicy({
      cfg,
      sessionKey,
      storePath,
      text: "backend failed",
    });

    expect(retryAfterFailure.shouldDeliver).toBe(true);

    await markOperationalReplyPolicyDelivered(retryAfterFailure, true);

    const duplicateAfterSuccess = await applyOncePolicy({
      cfg,
      sessionKey,
      storePath,
      text: "backend failed",
    });

    expect(duplicateAfterSuccess.shouldDeliver).toBe(false);
  });

  it("keeps durable once keys for the session lifetime", async () => {
    const existingKeys = Array.from({ length: 1025 }, (_value, index) => `existing-${index}`);
    const { sessionKey, storePath } = await createSessionStoreFixture({
      operationalReplyOnceKeys: existingKeys,
    });
    const cfg = onceConfig(storePath);

    const result = await applyOncePolicy({
      cfg,
      sessionKey,
      storePath,
      text: "new durable notice",
    });
    await markOperationalReplyPolicyDelivered(result, true);

    const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];

    expect(persisted?.operationalReplyOnceKeys?.slice(0, existingKeys.length)).toEqual(
      existingKeys,
    );
    expect(persisted?.operationalReplyOnceKeys).toHaveLength(existingKeys.length + 1);
  });
});
