import { expect, it, vi } from "vitest";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import * as reconciliation from "./session-sharing-authority-reconciliation.js";
import { readSessionSharingAuthorityHealth } from "./session-sharing-authority-state.js";
import {
  addSessionMember,
  readSessionMembersInWorker,
  removeSessionMember,
} from "./session-sharing-store.js";

const fault = useSqliteWorkerFault([
  { match: /^delete from session_members\b/iu, exitOnMatch: 1, afterStatement: true },
]);

it("retains restart guidance when worker death has no native settlement proof", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    await captureRuntimeConfigAsyncReader()();
    const scope = { agentId: "main", sessionKey: "agent:main:lost-sharing-write" };
    await upsertSessionEntryCore(scope, { sessionId: "lost-sharing-write", updatedAt: 1 });
    await addSessionMember(scope, { identityId: "guest", addedAt: 2, addedBy: "owner" });
    const cfg = { agents: { entries: { main: {} } } };
    const retained = await prepareSessionMutationFacts({ cfg, ...scope });
    const reconcile = reconciliation.reconcileUnknownSessionSharingAuthority;
    const observed = vi
      .spyOn(reconciliation, "reconcileUnknownSessionSharingAuthority")
      .mockImplementation((params) => reconcile({ ...params, settlement: undefined }));
    try {
      expect(readSessionSharingAuthorityHealth(true)).toBeUndefined();
      fault.enable();
      const mutation = removeSessionMember(scope, "guest", undefined, "lost-sharing-write").catch(
        (error: unknown) => error,
      );
      expect(hasSqliteWorkerOutcomeUnknown(await mutation)).toBe(true);
      fault.disable();
      expect(() => retained.readCurrent(cfg)).toThrow("Session access facts are unavailable");
      expect(readSessionSharingAuthorityHealth(true)).toEqual({
        restartRequired: true,
        affectedSessionCount: 1,
        sessionKeys: [scope.sessionKey],
        recovery: "Restart the Gateway to clear unknown session sharing authority.",
        reasons: ["native-unsettled"],
      });
      expect(
        (await readSessionMembersInWorker(scope)).members.map((member) => member.identityId),
      ).toEqual(["guest"]);
      // The first acquisition may meet the replacement worker's registry discovery refusal.
      await prepareSessionMutationFacts({ cfg, ...scope }).catch(() => undefined);
      await expect(prepareSessionMutationFacts({ cfg, ...scope })).rejects.toThrow(
        /restart the Gateway/i,
      );
      expect(readSessionSharingAuthorityHealth(false)?.restartRequired).toBe(true);
      await addSessionMember(scope, { identityId: "other", addedAt: 3, addedBy: "owner" });
      expect(() => retained.readCurrent(cfg)).toThrow("Session access facts are unavailable");
    } finally {
      observed.mockRestore();
      fault.disable();
      retained.release();
    }
  });
});
