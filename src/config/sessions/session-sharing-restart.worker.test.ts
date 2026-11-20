import { expect, it, vi } from "vitest";
import { useSqliteWorkerFault } from "../../../test/helpers/sqlite-worker-fault.js";
import type { HealthSummary } from "../../gateway/health/types.js";
import { healthHandlers } from "../../gateway/server-methods/health.js";
import { prepareSessionMutationFacts } from "../../gateway/session-sharing-preparation.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { captureRuntimeConfigAsyncReader } from "../io.runtime.js";
import { upsertSessionEntryCore } from "./session-accessor.js";
import * as reconciliation from "./session-sharing-authority-reconciliation.js";
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
    const snapshot: HealthSummary = {
      ok: true,
      ts: Date.now(),
      durationMs: 0,
      channels: {},
      channelOrder: [],
      channelLabels: {},
      heartbeatSeconds: 0,
      agents: [],
      sessions: { path: "[redacted]", count: 0, recent: [] },
    };
    const health = async (admin: boolean, probe: boolean) => {
      const respond = vi.fn();
      await healthHandlers.health!({
        req: {} as never,
        params: { probe },
        respond,
        client: { connect: { scopes: [admin ? "operator.admin" : "operator.read"] } } as never,
        context: {
          getHealthCache: () => snapshot,
          refreshHealthSnapshot: async () => snapshot,
          getRuntimeSnapshot: () => ({ channels: {}, channelAccounts: {} }),
          logHealth: { error: vi.fn() },
        } as never,
        isWebchatConnect: () => false,
      });
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      return respond.mock.calls[0]?.[1].sessionSharing;
    };
    const reconcile = reconciliation.reconcileUnknownSessionSharingAuthority;
    const observed = vi
      .spyOn(reconciliation, "reconcileUnknownSessionSharingAuthority")
      .mockImplementation((params) => reconcile({ ...params, settlement: undefined }));
    try {
      expect(await health(true, false)).toBeUndefined();
      fault.enable();
      const mutation = removeSessionMember(scope, "guest", undefined, "lost-sharing-write").catch(
        (error: unknown) => error,
      );
      expect(hasSqliteWorkerOutcomeUnknown(await mutation)).toBe(true);
      fault.disable();
      expect(() => retained.readCurrent(cfg)).toThrow("Session access facts are unavailable");
      for (const probe of [false, true]) {
        expect(await health(true, probe)).toEqual({
          restartRequired: true,
          affectedSessionCount: 1,
          sessionKeys: [scope.sessionKey],
          recovery: "Restart the Gateway to clear unknown session sharing authority.",
          reasons: ["native-unsettled"],
        });
        expect(await health(false, probe)).toEqual({
          restartRequired: true,
          affectedSessionCount: 1,
          recovery: "Restart the Gateway to clear unknown session sharing authority.",
          reasons: ["native-unsettled"],
        });
      }
      expect(
        (await readSessionMembersInWorker(scope)).members.map((member) => member.identityId),
      ).toEqual(["guest"]);
      await expect(prepareSessionMutationFacts({ cfg, ...scope })).rejects.toThrow(
        /restart the Gateway/i,
      );
      expect((await health(true, false)).restartRequired).toBe(true);
      await addSessionMember(scope, { identityId: "other", addedAt: 3, addedBy: "owner" });
      expect(() => retained.readCurrent(cfg)).toThrow("Session access facts are unavailable");
    } finally {
      observed.mockRestore();
      fault.disable();
      retained.release();
    }
  });
});
