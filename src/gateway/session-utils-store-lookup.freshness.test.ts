import { expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as sessionEntryReaders from "../config/sessions/session-entry-read-runtime.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withGatewaySessionStoreTarget } from "./session-utils-store-lookup.js";

it("consumes sharing facts committed before its ordered snapshot", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    const key = "agent:main:sharing-before-snapshot";
    const scope = { agentId: "main", sessionKey: key, env };
    await replaceSessionEntry(scope, { sessionId: "same-session", updatedAt: 1 });
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const committedMembers: string[] = [];
    const pendingMembers = ["first-member", "second-member"];
    const readEntries = sessionEntryReaders.withSessionEntriesFromStoresInWorker;
    const read = vi
      .spyOn(sessionEntryReaders, "withSessionEntriesFromStoresInWorker")
      .mockImplementation(async (inputs, consume, options) => {
        const identityId = pendingMembers.shift();
        if (identityId) {
          // Real writes win the FIFO before the reader starts its snapshot.
          await runOpenClawAgentWriteAdmission(
            { agentId: "main", path: database.path, env },
            () => {
              addSessionMember(scope, { identityId, addedBy: "owner", addedAt: 1 });
              committedMembers.push(identityId);
            },
          );
        }
        return readEntries(inputs, consume, options);
      });
    let consumptions = 0;
    try {
      const result = await withGatewaySessionStoreTarget(
        { cfg, key, env, includeMembership: true },
        (target, membership, assertCurrent) => {
          consumptions += 1;
          assertCurrent();
          expect(target.store[key]?.sessionId).toBe("same-session");
          return membership
            .get(key)
            ?.map((member) => member.identityId)
            .toSorted();
        },
      );
      expect(result).toContain("first-member");
      expect(result).toEqual(committedMembers.toSorted());
      expect(consumptions).toBe(1);
    } finally {
      read.mockRestore();
    }
  });
});
