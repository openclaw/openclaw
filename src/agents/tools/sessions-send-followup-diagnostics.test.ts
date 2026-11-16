import { Value } from "typebox/value";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureGatewayDeviceRevocation } from "../../gateway/device-revocation.js";
import { unwrapGatewayMethodDispatchResponse } from "../../gateway/server-in-process-dispatch.js";
import * as operatorContinuation from "../../gateway/server-plugin-in-process-dispatch.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { SessionMutationAuthorizationChangedError } from "../../gateway/session-mutation-authorization-error.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import * as sessionStateEvents from "../../sessions/session-state-events.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import {
  readFollowupRequest,
  SessionFollowupCompletion,
} from "../subagents/completion/session-followup-completion.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import * as sessionsSendFollowup from "./sessions-send-followup-custody.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";
import { SessionsSendOutputSchema } from "./sessions-send-tool.schema.js";

let state: OpenClawTestState;
const runId = "diagnostic-followup";
const config: OpenClawConfig = {
  agents: { ownership: "explicit", entries: { main: {} } },
  session: { mainKey: "main", scope: "per-sender" },
  tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
};
beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  setActivePluginRegistry(createSessionConversationTestRegistry());
  resetGatewayWorkAdmission();
});
afterEach(async () => {
  await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
  resetGatewayWorkAdmission();
  await state.cleanup();
});

it.each(["parent", "child", "authorized", "revoked", "revoked-before-admission"] as const)(
  "reports safe followup custody diagnostics through the tool result (%s)",
  async (outcome) => {
    const revoked = outcome === "revoked" || outcome === "revoked-before-admission";
    const parentKey = "agent:main:dashboard:staff-parent";
    const childKey = "agent:main:subagent:staff-child";
    const cfg: OpenClawConfig = {
      ...config,
      gateway: {
        roles: {
          default: "staff",
          definitions: {
            staff: {
              sessions: { others: "none" },
              agents: "*",
              scopes: ["operator.read", "operator.write"],
            },
          },
        },
      },
    };
    setRuntimeConfigSnapshot(cfg);
    const context = createContext([], () => cfg);
    const owner = createOperatorClient({
      profileName: "followup-staff",
      scopes: ["operator.write"],
    });
    const profileId = owner.authenticatedUserProfile!.profileId;
    setUserProfileRole(profileId, "staff");
    const source = captureGatewayDeviceRevocation(
      context,
      { deviceId: "staff-device", role: "operator" },
      () => true,
    );
    const hiddenIdentity = "hidden-legacy-person";
    for (const [sessionKey, endpoint] of [
      [parentKey, "parent"],
      [childKey, "child"],
    ] as const) {
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId: endpoint === "parent" ? "requester-session" : "target-session",
          updatedAt: 1,
          createdActor: {
            type: "human",
            source: "profile",
            id: outcome === endpoint ? hiddenIdentity : profileId,
          },
          ...(endpoint === "child"
            ? {
                spawnedBy: parentKey,
                parentSessionId: "requester-session",
                spawnDepth: 1,
              }
            : {}),
        },
      );
    }
    let completion: SessionFollowupCompletion | undefined;
    let retained: Awaited<ReturnType<typeof sessionsSendFollowup.prepareSessionsSendFollowup>>;
    const prepare = sessionsSendFollowup.prepareSessionsSendFollowup;
    const capture = vi
      .spyOn(sessionsSendFollowup, "prepareSessionsSendFollowup")
      .mockImplementation(async (params) => {
        retained = await prepare(params);
        return retained;
      });
    let submissions = 0;
    const callGateway = vi
      .fn()
      .mockImplementation(async (gatewayRequest: Parameters<AgentToolGatewayRequestCaller>[0]) => {
        if (gatewayRequest.method === "sessions.resolve") {
          return { key: childKey, agentId: "main" };
        }
        if (gatewayRequest.method === "sessions.list") {
          return {
            sessions: [{ key: childKey, agentId: "main", spawnedBy: parentKey }],
          };
        }
        if (gatewayRequest.method !== "agent") {
          throw new Error(`Unexpected Gateway method: ${gatewayRequest.method}`);
        }
        submissions += 1;
        const request = readFollowupRequest(runId, childKey);
        expect(request).toBeDefined();
        if (outcome !== "revoked-before-admission") {
          completion = SessionFollowupCompletion.bind(request!);
          request!.completion = completion;
          completion.markAccepted(runId);
        }
        if (revoked) {
          // A committed endpoint-policy denial after successful admission, not a new identity.
          await replaceSessionEntry(
            { agentId: "main", sessionKey: childKey },
            {
              sessionId: "target-session",
              updatedAt: 2,
              spawnedBy: parentKey,
              parentSessionId: "requester-session",
              spawnDepth: 1,
              createdActor: { type: "human", source: "profile", id: profileId },
              incognito: true,
            },
          );
          if (outcome === "revoked-before-admission") {
            try {
              SessionFollowupCompletion.bind(request!);
            } catch (error) {
              if (!(error instanceof SessionMutationAuthorizationChangedError)) {
                throw error;
              }
              // The real agent handler returns this envelope, and the in-process client unwraps it.
              return unwrapGatewayMethodDispatchResponse("agent", {
                ok: false,
                error: error.error,
              });
            }
            throw new Error("Revoked followup was admitted");
          }
        } else {
          await completion!.settle(runId, { status: "ok", replyText: "Staff child continued" });
          completion!.finishExecution(runId);
        }
        return { runId, status: "accepted" };
      });
    const releases: Array<MockInstance<() => void>> = [];
    const captureContinuation = operatorContinuation.captureOperatorToolGatewayContinuationContext;
    const release = vi
      .spyOn(operatorContinuation, "captureOperatorToolGatewayContinuationContext")
      .mockImplementation((...args) => {
        const pending = captureContinuation(...args);
        return pending?.then((captured) => {
          releases.push(vi.spyOn(captured, "release"));
          return captured;
        });
      });
    const registerWatch = vi.spyOn(sessionStateEvents, "registerSessionStateWatch");
    try {
      const result = await withPluginRuntimeGatewayRequestScope(
        {
          client: owner,
          context,
          isWebchatConnect: () => false,
          hasCurrentClientAuthority: source.isCurrent,
        },
        () =>
          withOperatorToolGatewayAuthority(
            {
              authenticatedUserProfile: owner.authenticatedUserProfile,
              scopes: owner.connect.scopes ?? [],
            },
            () =>
              withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey: parentKey,
                  gatewayContextResolver: () => context,
                  receiptAuthority: () => true,
                },
                () =>
                  createSessionsSendTool({
                    agentSessionKey: parentKey,
                    config: cfg,
                    idempotencyKey: runId,
                    callGateway,
                  }).execute("staff-followup", {
                    sessionKey: childKey,
                    message: "Continue the task",
                    mode: "followup",
                    timeoutSeconds: 1,
                    watch: outcome === "parent" || outcome === "child",
                  }),
              ),
          ),
      );
      expect(Value.Check(SessionsSendOutputSchema, result.details)).toBe(true);
      if (outcome === "authorized") {
        expect(result.details).toMatchObject({ status: "ok", reply: "Staff child continued" });
      } else {
        const endpoint = revoked ? "child" : outcome;
        expect(result.details).toMatchObject({
          status: revoked ? "error" : "forbidden",
          followupAccess: {
            phase: revoked ? "revocation" : "admission",
            endpoint,
            code: "INVALID_REQUEST",
          },
        });
        const serialized = JSON.stringify(result);
        for (const hidden of [
          hiddenIdentity,
          profileId,
          parentKey,
          childKey,
          "was not found",
          "cause",
        ]) {
          expect(serialized).not.toContain(hidden);
        }
        if (!revoked) {
          expect(serialized).not.toContain("revoked");
        } else {
          expect(retained?.custody.signal.aborted).toBe(true);
          expect(() => retained?.custody.assertCurrent()).toThrow("revoked");
          if (outcome === "revoked") {
            expect(result.details).toMatchObject({ sentBeforeError: true });
          } else {
            expect(result.details).not.toHaveProperty("sentBeforeError");
          }
        }
      }
      expect(submissions).toBe(outcome === "authorized" || revoked ? 1 : 0);
      expect(registerWatch).not.toHaveBeenCalled();
      if (completion) {
        expect(completion.signal.aborted).toBe(true);
      }
      expect(releases.length).toBeGreaterThan(0);
      for (const released of releases) {
        expect(released).toHaveBeenCalledOnce();
      }
    } finally {
      completion?.close();
      retained?.custody.release();
      capture.mockRestore();
      release.mockRestore();
      registerWatch.mockRestore();
      for (const released of releases) {
        released.mockRestore();
      }
      source.release();
    }
  },
);
