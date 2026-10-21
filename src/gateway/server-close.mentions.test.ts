import { expect, it, vi } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as agentDatabaseLifecycle from "../state/openclaw-agent-db-lifecycle.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as userProfiles from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { readMentionStoreSnapshot } from "./mention-inbox-store.worker.js";
import type { MentionCommittedInput } from "./mention-inbox.types.js";
import { createTestGate } from "./server-close.lifecycle.test-support.js";
import { createGatewayCloseRace } from "./server-close.race.test-support.js";

it("persists accepted mentions before Gateway close resolves", async ({ signal }) => {
  const race = await createGatewayCloseRace("gateway-mention-close", signal);
  const { fixture, kernel } = race;
  const gate = createTestGate(signal);
  const joining = new AbortController();
  const databasesClosing = createDeferredCore();
  let acceptedSettled = false;
  let accepted: Promise<void> | undefined;
  try {
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
        joining.abort();
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
    vi.spyOn(userProfiles, "prepareUserProfileCatalog").mockImplementationOnce(async (...args) => {
      const profiles = await prepareProfiles(...args);
      await race.block();
      return profiles;
    });
    accepted = kernel.mentionInbox.recordCommittedInputAsync(input).then(() => {
      acceptedSettled = true;
    });
    await race.waitForEntry(accepted, "Mention bypassed profile alias preparation");
    const shared = openOpenClawStateDatabase({ env: fixture.state.env }).db;
    const agent = openOpenClawAgentDatabase({ agentId: "main", env: fixture.state.env }).db;
    await gate(
      race.close(joining.signal, undefined, { reason: "mention close regression" }),
      databasesClosing.promise,
      "Gateway began database close before joining accepted mention persistence",
    );
    await kernel.mentionInbox.recordCommittedInputAsync({
      ...input,
      sourceId: "refused-after-close",
      messageId: "refused-after-close",
    });
    expect([acceptedSettled, shared.isOpen, agent.isOpen]).toEqual([false, true, true]);
    await race.finish(accepted);
    expect([acceptedSettled, shared.isOpen, agent.isOpen]).toEqual([true, false, false]);

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
    race.onCleanup(async () => {
      await Promise.allSettled([accepted]);
      vi.restoreAllMocks();
    });
    await race.dispose();
  }
});
