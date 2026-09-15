import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_OWNER_PROFILE_ID,
  validateMentionsListResult,
  type MentionsListResult,
} from "../../packages/gateway-protocol/src/index.js";
import { MENTION_RETENTION_MS, writeMentionStoreChanges } from "./mention-inbox-store.js";
import { READ_SCOPE } from "./operator-scopes.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail, setDisplayName } from "../state/user-profiles.js";
import { connectGatewayClient, disconnectGatewayClient } from "./test-helpers.e2e.js";
import { installGatewayTestHooks, testState, withGatewayServer, writeSessionStore } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const GATEWAY_TOKEN = "mention-dismiss-trim-e2e-token";
const SESSION_KEY = "agent:main:main";
const SESSION_ID = "mention-dismiss-trim-session";

describe("mentions.dismiss Gateway E2E", () => {
  it("dismisses a live mention when mentions.dismiss receives a padded id", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required for mention dismiss E2E fixtures");
    }
    testState.gatewayAuth = { mode: "token", token: GATEWAY_TOKEN };
    testState.sessionStorePath = path.join(stateDir, "sessions.sqlite");

    ensureGatewayOwnerProfile("mention-trim-owner");
    const sender = ensureProfileForEmail("sender@mentions.example.test");
    setDisplayName(sender.id, "Sender");
    expect(sender.id).not.toBe(GATEWAY_OWNER_PROFILE_ID);

    const mentionId = randomUUID();
    const sourceKey = createHash("sha256").update("mention-dismiss-trim-source").digest("hex");
    const createdAt = Date.now();

    await withGatewayServer(async ({ port }) => {
      await writeSessionStore({
        entries: {
          [SESSION_KEY]: {
            sessionId: SESSION_ID,
            updatedAt: Date.now(),
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: GATEWAY_OWNER_PROFILE_ID },
          },
        },
      });
      runOpenClawStateWriteTransaction(({ db }) => {
        writeMentionStoreChanges(
          db,
          { revision: 0, nextSequence: 1 },
          new Map([
            [
              sourceKey,
              {
                key: sourceKey,
                sequence: 0,
                expiresAt: createdAt + MENTION_RETENTION_MS,
                recipients: [[GATEWAY_OWNER_PROFILE_ID, mentionId]],
                message: {
                  sessionId: SESSION_ID,
                  content: {
                    senderProfileId: sender.id,
                    sessionKey: SESSION_KEY,
                    agentId: "main",
                    messageId: "mention-dismiss-trim-message",
                    createdAt,
                    excerpt: "@Owner review this change",
                  },
                },
              },
            ],
          ]),
        );
      });

      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token: GATEWAY_TOKEN,
        scopes: [READ_SCOPE],
        timeoutMs: 60_000,
      });
      try {
        const listed = await client.request<MentionsListResult>("mentions.list", {});
        expect(validateMentionsListResult(listed)).toBe(true);
        expect(listed.items.map((item) => item.id)).toContain(mentionId);

        const padded = ` ${mentionId} `;
        expect(padded).not.toBe(mentionId);
        const dismissed = await client.request<MentionsListResult>("mentions.dismiss", {
          ids: [padded],
        });
        expect(validateMentionsListResult(dismissed)).toBe(true);
        expect(dismissed.items.map((item) => item.id)).not.toContain(mentionId);

        const remaining = await client.request<MentionsListResult>("mentions.list", {});
        expect(remaining.items.map((item) => item.id)).not.toContain(mentionId);
        console.log(
          `[mentions.dismiss Gateway client E2E] listed=true dismissed=true remaining=0 padded=${JSON.stringify(padded)} exact=${mentionId}`,
        );
      } finally {
        await disconnectGatewayClient(client);
      }
    });
  }, 120_000);
});
