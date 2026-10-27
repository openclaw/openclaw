import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it } from "vitest";
import { requireLastRespondCall } from "../../../gateway/server-methods/chat.abort-authorization.test-helpers.js";
import { withExecRequestTurn } from "../../../infra/exec-request-context.js";
import { consumeSelectedSystemEventEntries } from "../../../infra/system-events.js";
import { normalizeAcceptedSessionSpawnResult } from "../../accepted-session-spawn.js";
import { captureExecRequestCancellation } from "../../bash-process-control.js";
import { killSubagentRunAdmin } from "../registry/subagent-control-kill.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { collectFailure } from "./subagent-spawn.fixtures.test-support.js";
import {
  createBoundSpawnInvocation,
  holdSpawnCapacity,
  type RequestCustodySpawnCaseOptions,
} from "./subagent-spawn.production-boundary.test-support.js";
import {
  parentRequestIdentity,
  createCustodyStop,
  registerCompletedRequestCustodySpawnCases,
  retainOriginalRequest,
} from "./subagent-spawn.request-custody-completed.test-support.js";

export function registerRequestCustodySpawnCases(options: RequestCustodySpawnCaseOptions) {
  const { parentSessionKey, parentRunId } = options;
  it.each(["exact", "session"] as const)(
    "stops a native child through retained original request custody after its routed turn completes (%s)",
    async (mode) => {
      const bound = await options.createBoundParent();
      const { runtime } = await options.createBoundGateway(bound);
      const { original, owners, event } = await retainOriginalRequest(
        bound,
        "original-exec-request",
        "original-exec-session",
        "Exec completed: continue original request",
      );
      const groupId = "routed-native-request";
      const capacity = "routed-native-capacity";
      await holdSpawnCapacity(JSON.stringify(["main", parentSessionKey, groupId]), capacity);
      let childRunId: string | undefined;
      let childSessionKey: string | undefined;
      const failures: unknown[] = [];
      await collectFailure(failures, async () => {
        const invoke = await withExecRequestTurn(
          {
            identity: parentRequestIdentity(parentRunId, parentSessionKey),
            owners,
          },
          async () =>
            createBoundSpawnInvocation(bound, { collect: true, groupId, context: "isolated" }),
        );
        // Tool invocation may occur outside the construction callback (including Code Mode).
        const result = await invoke();
        expect(result.details, JSON.stringify(result)).toMatchObject({
          status: "accepted",
          runId: expect.any(String),
        });
        const accepted = expectDefined(
          normalizeAcceptedSessionSpawnResult(result),
          "accepted routed native child",
        );
        childRunId = accepted.runId;
        childSessionKey = accepted.childSessionKey;
        bound.admission.close();
        bound.parent.cleanup();
        const commands = captureExecRequestCancellation(original);
        expect(commands.owners).toEqual(owners);
        const stopRequest = createCustodyStop(bound, original);
        const stop = (connId: string, exact = mode === "exact") => stopRequest(connId, exact);
        const foreign = requireLastRespondCall(await stop("another-owner"));
        if (mode === "exact") {
          expect(foreign[0]).toBe(false);
          expect(foreign[2]).toMatchObject({ message: "unauthorized" });
        } else {
          expect(foreign.slice(0, 2)).toEqual([true, { ok: true, aborted: false, runIds: [] }]);
        }
        expect(subagentRuns.get(childRunId)?.execution.status).toBe("queued");
        expect(owners.every((owner) => !owner.signal.aborted)).toBe(true);
        const stopped = requireLastRespondCall(await stop("request-owner"));
        expect(stopped.slice(0, 2)).toEqual([true, { ok: true, aborted: true, runIds: [] }]);
        expect(subagentRuns.get(childRunId)).toMatchObject({
          requesterTurnRunId: parentRunId,
          execution: { status: "terminal" },
        });
        options.assertNoModelExecution();
        expect(captureExecRequestCancellation(original).owners).toEqual([]);
        const historical = requireLastRespondCall(await stop("request-owner", true));
        expect(historical.slice(0, 2)).toEqual([true, { ok: true, aborted: false, runIds: [] }]);
      });
      consumeSelectedSystemEventEntries(original.sessionKey, [event]);
      if (childSessionKey) {
        const target = { cfg: bound.cfg, sessionKey: childSessionKey };
        await collectFailure(failures, () => killSubagentRunAdmin(target));
      }
      releaseSwarmRun(capacity);
      failures.push(...(await options.closeBoundGateway(bound, runtime, childRunId)));
      options.throwBoundFailures(failures);
    },
  );

  registerCompletedRequestCustodySpawnCases(options);
}
