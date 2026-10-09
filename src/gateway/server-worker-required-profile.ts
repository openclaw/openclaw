import { isDeepStrictEqual } from "node:util";
import type { SessionPlacementAdmissionProvider } from "../agents/session-placement-admission.js";
import {
  assertRequiredWorkerSelection,
  RequiredWorkerProfileError,
} from "../config/required-worker-profile.js";
import { composeSessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withGatewayWorkerSessionAdmission } from "./server-worker-placement-dispatch-admission.js";
import { ensureSessionWorkspaceForPlacement } from "./session-lifecycle-preparation.js";
import type { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";

/** Required placement contributes policy; the session and placement owners retain its effects. */
export function createRequiredWorkerSessionPreparation(options: {
  getConfig: () => OpenClawConfig;
  dispatch: Pick<ReturnType<typeof coordinateWorkerPlacementDispatch>, "ensurePlacement">;
}): NonNullable<SessionPlacementAdmissionProvider["withRequiredSession"]> {
  return async (identity, task, authorize, signal, preparation) => {
    const required = options.getConfig().cloudWorkers?.requiredProfile;
    if (!required) {
      return await task(() => {});
    }
    if (!identity.sessionKey?.trim() || !identity.agentId?.trim()) {
      throw new RequiredWorkerProfileError(
        "Required worker execution needs a real agent session; sessionless model helpers are unsupported.",
      );
    }
    const profile = options.getConfig().cloudWorkers?.profiles?.[required];
    if (!profile) {
      throw new RequiredWorkerProfileError(
        'Required worker profile "' + required + '" is not configured; configure it and retry.',
      );
    }
    const snapshot = structuredClone(profile);
    const assertPolicyCurrent = composeSessionSourceAssertion([authorize], (assertSource) => {
      signal?.throwIfAborted();
      assertSource();
      if (
        options.getConfig().cloudWorkers?.requiredProfile !== required ||
        !isDeepStrictEqual(options.getConfig().cloudWorkers?.profiles?.[required], snapshot)
      ) {
        throw new RequiredWorkerProfileError(
          "Session source or required worker policy changed during placement; retry.",
        );
      }
    });
    return await withGatewayWorkerSessionAdmission(
      {
        identity: {
          sessionId: identity.sessionId,
          sessionKey: identity.sessionKey,
          agentId: identity.agentId,
        },
        getConfig: options.getConfig,
        authorize: assertPolicyCurrent,
        signal,
        retainEntryFields: ["agentRuntimeOverride", "execNode"],
      },
      async (source) => {
        const assertCurrent = composeSessionSourceAssertion(
          [source.assertCurrent],
          (assertSource) => {
            assertSource();
            assertRequiredWorkerSelection(options.getConfig(), {
              agentRuntime: source.entry.agentRuntimeOverride,
              execNode: source.entry.execNode,
            });
          },
        );
        const placement = await options.dispatch.ensurePlacement({
          request: {
            sessionId: identity.sessionId,
            sessionKey: identity.sessionKey!,
            agentId: identity.agentId!,
            profileId: required,
            executionMode: "worker-turn",
            requiredProfile: required,
            runSetupScript: false,
            devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
          },
          assertCurrent,
          // Dispatch acquires its own session scope and retains it beyond an RPC acknowledgment.
          authorizeDispatch: assertPolicyCurrent,
          signal: source.signal,
          waitForReady: preparation?.waitForReady,
          prepareWorkspace: (canPrepare) =>
            ensureSessionWorkspaceForPlacement({
              cfg: options.getConfig(),
              ...source,
              assertCurrent,
              canPrepare,
            }),
        });
        try {
          placement.assertCurrent();
          return await task(placement.assertCurrent);
        } finally {
          placement.release();
        }
      },
    );
  };
}
