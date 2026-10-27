import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createSessionsCreateTool } from "../agents/tools/sessions-create-tool.js";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { readReplySourceInput } from "../auto-reply/reply/reply-source-binding.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.pending-inputs.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
import { requestRpcSourceCancellation } from "../sessions/session-controller.rpc-sources.js";
import { createReplyTurnParticipants } from "../sessions/session-controller.tool-authority.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import * as userTurnOwner from "./server-methods/chat-user-turn-recorder.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import { loadSessionEntryAsync } from "./session-entry-load.test-support.js";
import { dispatchInboundMessageMock, prepareGatewayReplyRuntimeForTest } from "./test-helpers.js";

export async function runIndependentCreationInputCase(
  context: GatewayRequestContext,
  boundary:
    | "slow acceptance"
    | "slow kickoff failure"
    | "before acceptance"
    | "after acceptance"
    | "guest after acceptance"
    | "participant after creation"
    | "participant after acceptance"
    | "target abort"
    | "target replacement"
    | "operator revocation",
  signal: AbortSignal,
) {
  await prepareGatewayReplyRuntimeForTest();
  const baseCfg = context.getRuntimeConfig();
  const guest = boundary === "guest after acceptance";
  const cfg: OpenClawConfig = guest
    ? {
        ...baseCfg,
        gateway: {
          ...baseCfg.gateway,
          roles: {
            ...baseCfg.gateway?.roles,
            definitions: {
              ...baseCfg.gateway?.roles?.definitions,
              "creation-guest": {
                agents: ["main"],
                scopes: ["operator.sessions.write"],
                sessions: { others: "none" },
                sandbox: "required",
              },
            },
          },
        },
      }
    : baseCfg;
  const cleanup: Array<() => void> = [];
  const slow = boundary.startsWith("slow");
  const creationReached = createDeferred();
  const releaseCreation = createDeferred();
  const executions: Promise<unknown>[] = [];
  const releaseDispatch = createDeferred();
  let dispatched: ReturnType<typeof dispatchInboundMessage> | undefined;
  let releaseWork: Promise<void> | undefined;
  const release = () => {
    releaseCreation.resolve();
    releaseDispatch.resolve();
  };
  signal.addEventListener("abort", release, { once: true });
  try {
    const runtimeConfig = guest
      ? vi.spyOn(context, "getRuntimeConfig").mockReturnValue(cfg)
      : undefined;
    if (runtimeConfig) {
      cleanup.push(() => runtimeConfig.mockRestore());
    }
    const policyConfig =
      guest && context.getCommittedRuntimeConfig
        ? vi.spyOn(context, "getCommittedRuntimeConfig").mockReturnValue(cfg)
        : undefined;
    if (policyConfig) {
      cleanup.push(() => policyConfig.mockRestore());
    }
    const sourceRunId = randomUUID();
    const sourceKey = "agent:main:dashboard:independent-source-" + randomUUID();
    const client = createOperatorClient({
      profileName: randomUUID(),
      scopes: guest ? ["operator.sessions.write"] : ["operator.admin"],
    });
    if (guest) {
      setUserProfileRole(
        expectDefined(client.authenticatedUserProfile, "guest profile").profileId,
        "creation-guest",
      );
    }
    const sourceRevocation = new AbortController();
    const operator = expectDefined(
      await captureGatewayOperatorRunAuthority({
        client,
        context,
        sourceAuthority: {
          signal: sourceRevocation.signal,
          assertCurrent: () => sourceRevocation.signal.throwIfAborted(),
        },
      }),
      "verified operator",
    );
    cleanup.push(() => operator.release());
    const admission = prepareAgentRunAdmission({
      cfg,
      operationalRunInstance: createOperationalRunInstanceRef(sourceRunId),
      operatorAuthority: operator.authority,
      facts: {
        runId: sourceRunId,
        agentId: "main",
        ingress: { kind: "gateway-client", boundary: "agent", state: "present" },
      },
    });
    cleanup.push(() => admission.close());
    const admitted = await admission.admit("embedded");
    const participants = createReplyTurnParticipants({ operatorAuthority: operator.authority });
    cleanup.push(() => participants.close());
    const steering = boundary.startsWith("participant")
      ? await captureGatewayOperatorRunAuthority({
          client: createOperatorClient({ profileName: randomUUID(), scopes: ["operator.admin"] }),
          context,
        })
      : undefined;
    if (steering) {
      cleanup.push(() => steering.release());
    }
    const initialKeys = new Set(
      await sessionAccessor.listSessionEntryKeysReadOnly({ agentId: "main" }),
    );
    const toolAbort = new AbortController();
    const dispatchEntered = createDeferred<Parameters<typeof dispatchInboundMessage>[0]>();
    cleanup.push(() => dispatchInboundMessageMock.mockReset());
    dispatchInboundMessageMock.mockReset().mockImplementation((args) => {
      expectDefined(args.replyOptions?.userTurnTranscriptRecorder, "accepted input recorder");
      dispatchEntered.resolve(args);
      dispatched = releaseDispatch.promise.then(() => ({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      }));
      return dispatched;
    });
    if (slow) {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      cleanup.push(() => vi.useRealTimers());
      const trackExecution = context.trackExecution.bind(context);
      const executionSpy = vi.spyOn(context, "trackExecution").mockImplementation((work) => {
        const execution = trackExecution(work);
        executions.push(execution);
        return execution;
      });
      cleanup.push(() => executionSpy.mockRestore());
    }
    const createUserTurn = userTurnOwner.createGatewayChatUserTurnController;
    const commitSpy = vi
      .spyOn(userTurnOwner, "createGatewayChatUserTurnController")
      .mockImplementationOnce((...args) => {
        const turn = createUserTurn(...args);
        const persist = turn.persist;
        turn.persist = async (...options) => {
          if (slow) {
            // Creation has committed its row before accepting the opening turn.
            creationReached.resolve();
            await withinTest(releaseCreation.promise, signal);
            if (boundary === "slow kickoff failure") {
              throw new Error("opening input unavailable");
            }
          }
          if (boundary === "before acceptance") {
            participants.close();
            admission.close();
            toolAbort.abort(new Error("originating tool stopped"));
          } else if (boundary === "participant after creation") {
            participants.accept({
              operatorAuthority: expectDefined(steering, "second participant").authority,
            });
          }
          const committed = await persist(...options);
          if (boundary === "participant after acceptance") {
            participants.accept({
              operatorAuthority: expectDefined(steering, "second participant").authority,
            });
          } else if (
            boundary !== "before acceptance" &&
            boundary !== "participant after creation"
          ) {
            // End the source after real SQLite commitment, but before the ACK.
            participants.close();
            admission.close();
            toolAbort.abort(new Error("originating tool stopped"));
          }
          return committed;
        };
        return turn;
      });
    cleanup.push(() => commitSpy.mockRestore());
    const creation = withPluginRuntimeGatewayRequestScope(
      { client, context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
      () =>
        withGatewayToolCallerIdentity(
          {
            ...expectDefined(
              createAdmittedGatewayToolCallerIdentity({
                admittedRunContext: admitted,
                // The initiating request is human-authored, independently of its execution grant.
                requesterOrigin: {
                  sessionKey: sourceKey,
                  operatorProfileId: expectDefined(
                    client.authenticatedUserProfile,
                    "requesting profile",
                  ).profileId,
                },
                agentId: "main",
                sessionKey: sourceKey,
              }),
              "admitted source caller",
            ),
            personalToolParticipants: participants,
          },
          () =>
            expectDefined(createSessionsCreateTool(), "available create tool").execute(
              "create-custody",
              {
                label: `Independent input: ${boundary}`,
                message: "/reset is an investigation subject, not a command",
              },
              toolAbort.signal,
            ),
        ),
    );
    const outcome = creation.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    if (slow) {
      await withinTest(
        awaitGateBeforeSettlement(
          creationReached.promise,
          creation,
          "creation settled before input commitment",
        ),
        signal,
      );
      await vi.advanceTimersByTimeAsync(10_001);
      releaseCreation.resolve();
    }
    const settled = await withinTest(outcome, signal);
    if ("error" in settled) {
      throw settled.error;
    }
    const { result } = settled;
    const accepted = boundary !== "before acceptance" && boundary !== "slow kickoff failure";
    expect(result.details).toMatchObject({
      sessionKey: expect.any(String),
      sessionId: expect.any(String),
      runStarted: accepted,
    });
    // SAFETY: The real creation owner supplies the receipt; required identity fields are asserted above.
    const receipt = result.details as {
      sessionKey: string;
      sessionId: string;
      runId?: string;
      runError?: unknown;
    };
    const target = await loadSessionEntryAsync(receipt.sessionKey, { agentId: "main" });
    const scope = {
      agentId: "main",
      sessionKey: receipt.sessionKey,
      sessionId: receipt.sessionId,
      storePath: target.storePath,
    };
    expect(target.entry).toMatchObject({
      createdVia: "operator",
      createdActor: { type: "human", source: "profile", id: operator.authority.profileId },
    });
    expect(target.entry?.spawnedBy).toBeUndefined();
    expect(target.entry?.spawnDepth ?? 0).toBe(0);
    if (guest) {
      expect(target.entry?.sandbox).toBe("required");
      expect(operator.authority.scopes).toEqual(["operator.sessions.write"]);
    }
    expect(commitSpy).toHaveBeenCalledOnce();
    expect(
      (await sessionAccessor.listSessionEntryKeysReadOnly({ agentId: "main" })).filter(
        (key) => !initialKeys.has(key),
      ),
    ).toEqual([receipt.sessionKey]);
    if (!accepted) {
      expect(receipt.runError).toBeDefined();
      expect((await listSessionPendingInputs(scope)).total).toBe(0);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      return;
    }
    const dispatchedInput = await withinTest(dispatchEntered.promise, signal);
    const recorder = expectDefined(
      dispatchedInput.replyOptions?.userTurnTranscriptRecorder,
      "committed input recorder",
    );
    const input = expectDefined(
      readReplySourceInput(dispatchedInput.replyOptions),
      "accepted physical source",
    );
    releaseWork = captureSessionControllerSettlement({
      scope: target.storePath,
      identities: [receipt.sessionKey, receipt.sessionId],
      agentId: "main",
    });
    expect(releaseWork).toBeDefined();
    expect((await listSessionPendingInputs(scope)).total).toBe(0);
    expect(recorder.getPersistedMessage?.()).toMatchObject({
      __openclaw: { senderId: "agent:main" },
      provenance: {
        kind: "inter_session",
        sourceSessionKey: sourceKey,
        sourceTool: "sessions_create",
      },
    });
    expect(recorder.getPersistedMessage?.()).not.toHaveProperty("__openclaw.senderIdentity");
    expect(recorder.getPersistedMessage?.()).not.toHaveProperty("__openclaw.senderName");
    const committedTranscript = sessionAccessor.loadTranscriptEventsSync(scope);
    const committedReceipt = recorder.getAdmissionReceipt();
    expect(committedReceipt).toBeDefined();
    if (boundary === "target abort") {
      requestRpcSourceCancellation(
        expectDefined(
          rpcSourceTesting.get(expectDefined(receipt.runId, "started run")),
          "target abort owner",
        ),
        new Error("target stopped"),
      );
    } else if (boundary === "target replacement") {
      await sessionAccessor.replaceSessionEntry(
        { agentId: "main", sessionKey: receipt.sessionKey },
        {
          ...expectDefined(target.entry, "created session"),
          sessionId: randomUUID(),
        },
      );
    } else if (boundary === "operator revocation") {
      sourceRevocation.abort(new Error("operator revoked"));
    }
    const persist = () => {
      input.abortSignal.throwIfAborted();
      expectDefined(input.sourceAdapter?.authority, "accepted source authority").assertCurrent();
      return recorder.persistApproved();
    };
    if (
      boundary === "slow acceptance" ||
      boundary === "after acceptance" ||
      boundary === "guest after acceptance" ||
      boundary === "participant after creation" ||
      boundary === "participant after acceptance"
    ) {
      const persisted = await persist();
      expect(persisted).toMatchObject({
        message: {
          content: "/reset is an investigation subject, not a command",
          __openclaw: { senderId: "agent:main" },
          provenance: { kind: "inter_session" },
        },
      });
      expect((await listSessionPendingInputs(scope)).total).toBe(0);
    } else if (boundary === "target replacement") {
      const replacement = expectDefined(
        (await loadSessionEntryAsync(receipt.sessionKey)).entry,
        "replacement",
      );
      expect(replacement.sessionId).not.toBe(receipt.sessionId);
      const replacementScope = { ...scope, sessionId: replacement.sessionId };
      const originalTranscript = sessionAccessor.loadTranscriptEventsSync(scope);
      const replacementTranscript = sessionAccessor.loadTranscriptEventsSync(replacementScope);
      await expect(Promise.resolve().then(persist)).rejects.toThrow();
      expect(recorder.getAdmissionReceipt()).toEqual(committedReceipt);
      expect((await loadSessionEntryAsync(receipt.sessionKey)).entry?.sessionId).toBe(
        replacement.sessionId,
      );
      expect(sessionAccessor.loadTranscriptEventsSync(scope)).toEqual(originalTranscript);
      expect(sessionAccessor.loadTranscriptEventsSync(replacementScope)).toEqual(
        replacementTranscript,
      );
    } else {
      await expect(Promise.resolve().then(persist)).rejects.toThrow();
      expect(recorder.getAdmissionReceipt()).toEqual(committedReceipt);
    }
    expect(sessionAccessor.loadTranscriptEventsSync(scope)).toEqual(committedTranscript);
  } finally {
    release();
    await Promise.allSettled(executions);
    await Promise.allSettled([dispatched, releaseWork]);
    for (const dispose of cleanup.toReversed()) {
      dispose();
    }
    signal.removeEventListener("abort", release);
  }
}
