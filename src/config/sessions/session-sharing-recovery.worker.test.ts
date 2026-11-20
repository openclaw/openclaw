import { channel } from "node:diagnostics_channel";
import path from "node:path";
import { expect, it } from "vitest";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import {
  addSessionMember,
  readSessionMembersInWorker,
  removeSessionMember,
} from "./session-sharing-store.js";

const fault = useSqliteWorkerFault([
  { match: /^delete from session_members\b/iu, exitOnMatch: 1, afterStatement: true },
  { match: /^delete from session_members\b/iu, exitOnMatch: 1, afterCommit: true },
]);

it.each([
  { outcome: "rolled-back", custom: false },
  { outcome: "committed", custom: false },
  { outcome: "committed", custom: true },
] as const)(
  "recovers fresh sharing after $outcome worker death (custom store: $custom) without reviving old grants",
  async ({ outcome, custom }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await captureRuntimeConfigAsyncReader()();
      const storePath = custom ? path.join(state.root, "shared.json") : undefined;
      if (custom) {
        await upsertSessionEntryCore(
          { agentId: "main", storePath, sessionKey: "agent:main:anchor" },
          { sessionId: "anchor", updatedAt: 1 },
        );
      }
      const agentId = custom ? "ops" : "main";
      const scope = { agentId, storePath, sessionKey: `agent:${agentId}:worker-loss` };
      const cfg = {
        agents: { entries: { main: {}, ops: {} } },
        ...(custom ? { session: { store: storePath } } : {}),
      };
      await upsertSessionEntryCore(scope, { sessionId: "worker-loss", updatedAt: 1 });
      await addSessionMember(scope, { identityId: "guest", addedAt: 2, addedBy: "owner" });
      const old = await prepareSessionMutationFacts({ cfg, ...scope });
      const events: unknown[] = [];
      const observe = (event: unknown) => events.push(event);
      const diagnostics = channel("openclaw.session-sharing.reconciliation");
      diagnostics.subscribe(observe);
      try {
        fault.enable(outcome === "committed" ? 1 : 0);
        const failure = await removeSessionMember(scope, "guest", undefined, "worker-loss").catch(
          (error: unknown) => error,
        );
        expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
        fault.disable();
        expect(() => old.readCurrent(cfg)).toThrow("Session access facts are unavailable");
        const expected = outcome === "committed" ? [] : ["guest"];
        expect(
          (await readSessionMembersInWorker(scope)).members.map((member) => member.identityId),
        ).toEqual(expected);
        const fresh = await prepareSessionMutationFacts({ cfg, ...scope });
        try {
          expect([...fresh.readCurrent(cfg).membership]).toEqual(expected);
        } finally {
          fresh.release();
        }
        expect(events).toEqual([
          { event: "reconcile-attempted", affectedSessionCount: 1 },
          { event: "reconcile-settled", affectedSessionCount: 1 },
        ]);
        await addSessionMember(scope, { identityId: "other", addedAt: 3, addedBy: "owner" });
        expect(() => old.readCurrent(cfg)).toThrow("Session access facts are unavailable");
      } finally {
        fault.disable();
        old.release();
        diagnostics.unsubscribe(observe);
      }
    });
  },
);
