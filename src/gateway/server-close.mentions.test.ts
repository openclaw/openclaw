import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as agentDatabaseLifecycle from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as userProfiles from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { readMentionStoreSnapshot } from "./mention-inbox-store.js";
import type { MentionCommittedInput } from "./mention-inbox.types.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";

it.for([false, true])(
  "persists accepted mentions before Gateway close (process exit=%s)",
  async (processExit, { signal }) => {
    const fixture = await createGatewayMetadataCloseFixture("gateway-mention-close");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const joining = createDeferredCore();
    const databasesClosing = createDeferredCore();
    let acceptedSettled = false;
    let closing: Promise<void> | undefined;
    let accepted: Promise<void> | undefined;
    try {
      const port = await fixture.reservePort();
      const server = await fixture.start(port);
      const kernel = fixture.kernels.get(port);
      assert(kernel);
      const closeDatabases = agentDatabaseLifecycle.closeOpenClawAgentDatabasesAsync;
      vi.spyOn(agentDatabaseLifecycle, "closeOpenClawAgentDatabasesAsync").mockImplementation(
        (...args) => {
          databasesClosing.resolve();
          return closeDatabases(...args);
        },
      );
      const dispose = kernel.mentionInbox.dispose;
      let fenced = false;
      vi.spyOn(kernel.mentionInbox, "dispose").mockImplementation(() => {
        const pending = dispose();
        // The prelude fences first; observe the later join without settling its work.
        if (fenced) {
          joining.resolve();
        }
        fenced = true;
        return pending;
      });
      const alice = ensureProfileForEmail("alice@mentions.example.test");
      const bob = ensureProfileForEmail("bob@mentions.example.test");
      const sessionKey = "agent:main:mention-close";
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: "mention-close-session",
          updatedAt: 1,
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: alice.id },
        },
      );
      await kernel.mentionInbox.invalidateAsync();
      const input: MentionCommittedInput = {
        sourceId: "accepted-before-close",
        committedSource: { generation: "mention-close", sequence: 1, timestamp: 1 },
        sessionKey,
        agentId: "main",
        sessionId: "mention-close-session",
        messageId: "accepted-before-close",
        senderProfileId: alice.id,
        recipientProfileIds: [bob.id],
        excerpt: "@Bob review this change",
      };
      const prepareProfiles = userProfiles.prepareUserProfileCatalog;
      vi.spyOn(userProfiles, "prepareUserProfileCatalog").mockImplementationOnce(
        async (...args) => {
          const profiles = await prepareProfiles(...args);
          entered.resolve();
          await release.promise;
          return profiles;
        },
      );
      accepted = kernel.mentionInbox.recordCommittedInputAsync(input).then(() => {
        acceptedSettled = true;
      });
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          accepted,
          "Mention settled without preparing involvement profile aliases",
        ),
        signal,
      );
      const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
      const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env }).db;
      const onProcessExitReady = vi.fn(async () => {
        expect(acceptedSettled).toBe(true);
        expect(agent.isOpen).toBe(false);
      });
      closing = server.close({
        reason: "mention close regression",
        ...(processExit ? { onProcessExitReady } : {}),
      });
      await withinTest(
        awaitGateBeforeSettlement(
          joining.promise,
          Promise.race([databasesClosing.promise, closing]),
          "Gateway began database close before joining accepted mention persistence",
        ),
        signal,
      );
      expect(onProcessExitReady).not.toHaveBeenCalled();
      await kernel.mentionInbox.recordCommittedInputAsync({
        ...input,
        sourceId: "refused-after-close",
        messageId: "refused-after-close",
      });
      expect(shared.isOpen).toBe(true);
      expect(agent.isOpen).toBe(true);
      release.resolve();
      await accepted;
      await closing;
      expect(onProcessExitReady).toHaveBeenCalledTimes(processExit ? 1 : 0);
      expect(shared.isOpen).toBe(false);
      expect(agent.isOpen).toBe(false);

      // Read durable results after the real close; a second Gateway boot adds no settlement proof.
      const stored = withExistingOpenClawStateDatabaseReadOnly(
        ({ db }) => readMentionStoreSnapshot(-1, db),
        { env: fixture.state.env },
      );
      expect(stored?.sources.map((source) => source.message?.content.messageId)).toEqual([
        "accepted-before-close",
      ]);
      expect(stored?.sources[0]?.recipients).toEqual([[bob.id, expect.any(String)]]);
      expect(
        loadSessionEntry({ agentId: "main", sessionKey })?.profileInvolvement?.profiles[bob.id],
      ).toMatchObject({ hidden: false, lastMention: input.committedSource });
    } finally {
      release.resolve();
      await Promise.allSettled([accepted, closing]);
      vi.restoreAllMocks();
      await fixture.cleanup();
    }
  },
);
