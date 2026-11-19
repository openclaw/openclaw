// Continuation (karmaterminal): a continue_work wake re-checks its retained operator custody once
// (🌊's O4 ruling on #129388). A channel source sets no `reauthorize`, so the wake's refusal rests
// on `custody.assertCurrent()` being live. A restored scheduled source keeps its admission fixed
// once started (upstream #201377) and re-checks the owner's current policy through `reauthorize`,
// which the wake calls once. These cases arm the real continue_work tool under a channel
// operator's and a scheduled operator's own authority, change that authority after the turn, then
// run the real wake.
// Real: the channel ingress and host context, the scheduled source restore, the continue_work
// tool, the in-process custody capture and the wake. Observed only: the turn the wake would start
// and the failed row it would write.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { AdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { createContinueWorkTool } from "../../agents/tools/continue-work-tool.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { invalidateGatewayDeviceRevocation } from "../../gateway/device-revocation.js";
import { captureQueuedOperatorRecoverySource } from "../../gateway/operator-run-recovery-source.js";
import { withRecovery } from "../../gateway/operator-run-recovery.test-support.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { changeCanonicalUserChannelIdentity } from "../../state/user-channel-identity-operations.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import type { ContinueWorkRequest } from "./types.js";
import type { PendingContinuationWork } from "./work-flow-state.js";
import {
  executePendingWorkWithOperatorContinuation,
  resetWorkOperatorContinuationsForTests,
  retainWorkOperatorContinuation,
} from "./work-operator-continuation.js";

const observed = vi.hoisted(() => ({
  turns: [] as Array<{ profileId?: string }>,
  failed: [] as Array<{ summary: string; options: unknown[] }>,
}));
vi.mock("./work-dispatch-execution.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./work-dispatch-execution.js")>()),
  executePendingContinuationWork: async () => {
    observed.turns.push({
      profileId:
        getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority?.profileId,
    });
    return { kind: "dispatched" as const };
  },
}));
vi.mock("./work-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./work-store.js")>()),
  markPendingWorkFailed: async (
    _work: PendingContinuationWork,
    summary: string,
    ...options: unknown[]
  ) => {
    observed.failed.push({ summary, options });
    return true;
  },
}));

afterEach(() => {
  resetWorkOperatorContinuationsForTests();
  observed.turns.length = 0;
  observed.failed.length = 0;
});

/** One turn's continue_work call under the producer's authority, and the wake it armed. */
async function armContinueWork(params: {
  sessionKey: string;
  authority: AdmittedRunOperatorAuthority;
  context: GatewayRequestContext;
}) {
  const requests: ContinueWorkRequest[] = [];
  const tool = createContinueWorkTool({
    agentSessionKey: params.sessionKey,
    requestContinuation: (request) => {
      requests.push(request);
    },
  });
  await withGatewayToolCallerIdentity(
    {
      agentId: "main",
      sessionKey: params.sessionKey,
      operatorAuthority: params.authority,
      gatewayContextResolver: () => params.context,
    },
    () => tool.execute("continue-1", { reason: "finish the second half", delaySeconds: 5 }),
  );
  const custody = expectDefined(requests[0]?.operatorContinuation, "retained operator custody");
  const retained = expectDefined(custody.operatorAuthority, "retained operator authority");
  const flowId = `flow-${params.sessionKey}`;
  retainWorkOperatorContinuation(flowId, params.sessionKey, custody);
  const work: PendingContinuationWork = {
    sessionKey: params.sessionKey,
    hop: 1,
    delayMs: 5_000,
    electedAt: Date.now(),
    dueAt: Date.now(),
    maxChainLength: 5,
    operatorAuthorityRequired: true,
    flowId,
    expectedRevision: 1,
  };
  return {
    retained: retained as AdmittedRunOperatorAuthority,
    wake: () =>
      executePendingWorkWithOperatorContinuation(
        work,
        {} as Parameters<typeof executePendingWorkWithOperatorContinuation>[1],
        new AbortController().signal,
      ),
  };
}

function expectWake(
  result: Awaited<ReturnType<typeof executePendingWorkWithOperatorContinuation>>,
  profileId: string,
  refused: boolean,
) {
  if (refused) {
    // Refused before a turn starts, and the failed row owes no notice.
    expect(result).toEqual({ kind: "failed" });
    expect(observed.turns).toEqual([]);
    expect(observed.failed).toEqual([
      { summary: expect.stringContaining("Retained operator authority revoked"), options: [] },
    ]);
  } else {
    expect(result).toEqual({ kind: "dispatched" });
    expect(observed.turns).toEqual([{ profileId }]);
    expect(observed.failed).toEqual([]);
  }
}

// The custody restores a saved channel source; a source past its recovery bound keeps the live
// channel authority itself (upstream's "preserves live channel work at recovery bounds").
it.for(
  (["saved", "live"] as const).flatMap((source) =>
    (["authorized", "role demoted", "identity unlinked"] as const).map((change) => ({
      source,
      change,
    })),
  ),
)(
  "a channel operator's continue_work wake checks the $source source live ($change)",
  ({ source, change }) =>
    withAdminIngress(async ({ admins, cfg, context, gateway, activatePolicy }) => {
      const admin = expectDefined(admins[0], "linked channel operator");
      // As a production Gateway context does, resolve the owner a detached capture restores against.
      gateway.resolveGatewayContext = () => gateway;
      if (source === "live") {
        cfg.agents = { entries: { main: { model: "fixture/permitted" } } };
        const roles = expectDefined(cfg.gateway?.roles, "configured channel roles");
        const adminRole = expectDefined(roles.definitions.admin, "administrator role");
        await activatePolicy({
          roles: {
            ...roles,
            definitions: {
              ...roles.definitions,
              admin: {
                ...adminRole,
                modelPolicy: {
                  sourceAgent: "main",
                  allow: ["fixture/*"],
                  deny: Array.from({ length: 257 }, (_, index) => `fixture/blocked-${index}/*`),
                },
              },
            },
          },
        });
      }
      const turn = await context(admin.identity.senderId);
      const authority = expectDefined(
        getCommandOwnerAuthority(turn)?.operatorAuthority,
        "channel operator authority",
      );
      expect(captureQueuedOperatorRecoverySource(authority)?.kind).toBe(
        source === "saved" ? "channel" : "unavailable",
      );
      const { retained, wake } = await armContinueWork({
        sessionKey: expectDefined(turn.SessionKey, "channel session"),
        authority,
        context: gateway,
      });
      if (source === "saved") {
        expect(retained).not.toBe(authority);
        expect(retained.channelRecoverySource).toBeDefined();
      } else {
        expect(retained).toBe(authority);
      }
      // The wake's optional re-check has nothing to call; `assertCurrent` carries the refusal.
      expect(retained.reauthorize).toBeUndefined();

      if (change === "role demoted") {
        setUserProfileRole(admin.profile.id, "member");
      } else if (change === "identity unlinked") {
        await changeCanonicalUserChannelIdentity("unlink", admin.profile.id, admin.identity);
      }
      expectWake(await wake(), admin.profile.id, change !== "authorized");
    }),
);

it.each(["authorized", "role changed", "device revoked"] as const)(
  "a scheduled operator's continue_work wake checks the restored source live (%s)",
  (change) =>
    withRecovery(async (fixture, _stateDir, profile) => {
      setRuntimeConfigSnapshot({});
      // A scheduled run's authority: restoreCronOperatorSource restores its saved source here.
      const scheduled = expectDefined(await fixture.restore(), "scheduled operator authority");
      try {
        const { retained, wake } = await armContinueWork({
          sessionKey: fixture.target.sessionKey,
          authority: scheduled.authority,
          context: fixture.context,
        });
        // The custody restores the run's saved source again, without the occurrence's checks.
        expect(retained).not.toBe(scheduled.authority);
        expect(retained.recoverySnapshot).toBeDefined();
        // Its admission is fixed after start; the wake's re-check reads the current policy.
        expect(retained.reauthorize).toBeTypeOf("function");
        fixture.retire();
        scheduled.release();

        if (change === "role changed") {
          setUserProfileRole(profile.id, "viewer");
        } else if (change === "device revoked") {
          invalidateGatewayDeviceRevocation(fixture.context, "recovery-device", "operator");
        }
        expectWake(await wake(), profile.id, change !== "authorized");
      } finally {
        scheduled.release();
      }
    }),
);
