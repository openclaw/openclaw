import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, vi } from "vitest";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
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
import { createReplyTurnParticipants } from "../auto-reply/reply/reply-run-registry.tool-authority.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../config/sessions/session-accessor.pending-inputs.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import { loadSessionEntry } from "./session-utils.js";
import { dispatchInboundMessageMock, prepareGatewayReplyRuntimeForTest } from "./test-helpers.js";

export async function runIndependentCreationInputCase(
  context: GatewayRequestContext,
  boundary:
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
  const releaseDispatch = createDeferred();
  let dispatched: ReturnType<typeof dispatchInboundMessage> | undefined;
  let releaseWork: Promise<void> | undefined;
  const release = () => releaseDispatch.resolve();
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
    const dispatchEntered = createDeferred<UserTurnTranscriptRecorder>();
    cleanup.push(() => dispatchInboundMessageMock.mockReset());
    dispatchInboundMessageMock.mockReset().mockImplementation((args) => {
      const recorder = expectDefined(
        args.replyOptions?.userTurnTranscriptRecorder,
        "accepted input recorder",
      );
      dispatchEntered.resolve(recorder);
      dispatched = releaseDispatch.promise.then(() => ({
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      }));
      return dispatched;
    });
    const stage = sessionAccessor.stageSessionPendingInput;
    const stageSpy = vi
      .spyOn(sessionAccessor, "stageSessionPendingInput")
      .mockImplementationOnce(async (...args) => {
        if (boundary === "before acceptance") {
          participants.close();
          admission.close();
          toolAbort.abort(new Error("originating tool stopped"));
        } else if (boundary === "participant after creation") {
          participants.accept({
            operatorAuthority: expectDefined(steering, "second participant").authority,
          });
        }
        const pending = await stage(...args);
        if (boundary === "participant after acceptance") {
          participants.accept({
            operatorAuthority: expectDefined(steering, "second participant").authority,
          });
        } else if (boundary !== "before acceptance" && boundary !== "participant after creation") {
          // End the source after real SQLite acceptance, but before chat.send ACKs.
          participants.close();
          admission.close();
          toolAbort.abort(new Error("originating tool stopped"));
        }
        return pending;
      });
    cleanup.push(() => stageSpy.mockRestore());
    const result = await withPluginRuntimeGatewayRequestScope(
      { client, context, resolveGatewayContext: () => context, isWebchatConnect: () => false },
      () =>
        withGatewayToolCallerIdentity(
          {
            ...expectDefined(
              createAdmittedGatewayToolCallerIdentity({
                admittedRunContext: admitted,
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
    const accepted = boundary !== "before acceptance" && boundary !== "participant after creation";
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
    const target = loadSessionEntry(receipt.sessionKey, { agentId: "main" });
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
    expect(stageSpy).toHaveBeenCalledOnce();
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
    const recorder = await withinTest(dispatchEntered.promise, signal);
    releaseWork = getSessionWorkAdmissionRelease({
      scope: target.storePath,
      identities: [receipt.sessionKey, receipt.sessionId],
    });
    expect(releaseWork).toBeDefined();
    expect((await listSessionPendingInputs(scope)).total).toBe(1);
    expect(recorder.getPendingInputMessage?.()).toMatchObject({
      __openclaw: { senderId: "agent:main" },
      provenance: {
        kind: "inter_session",
        sourceSessionKey: sourceKey,
        sourceTool: "sessions_create",
      },
    });
    expect(recorder.getPendingInputMessage?.()).not.toHaveProperty("__openclaw.senderIdentity");
    expect(recorder.getPendingInputMessage?.()).not.toHaveProperty("__openclaw.senderName");
    if (boundary === "target abort") {
      expectDefined(
        context.chatAbortControllers.get(expectDefined(receipt.runId, "started run")),
        "target abort owner",
      ).controller.abort(new Error("target stopped"));
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
    const persist = () =>
      expectDefined(
        recorder.withPendingInput,
        "accepted custody",
      )(() => recorder.persistApproved());
    if (
      boundary === "after acceptance" ||
      boundary === "guest after acceptance" ||
      boundary === "participant after acceptance"
    ) {
      const persisted = await persist();
      expect(persisted).toMatchObject({
        appended: true,
        message: {
          content: "/reset is an investigation subject, not a command",
          __openclaw: { senderId: "agent:main" },
          provenance: { kind: "inter_session" },
        },
      });
      expect((await listSessionPendingInputs(scope)).total).toBe(0);
    } else if (boundary === "target replacement") {
      const replacement = expectDefined(loadSessionEntry(receipt.sessionKey).entry, "replacement");
      expect(replacement.sessionId).not.toBe(receipt.sessionId);
      const replacementScope = { ...scope, sessionId: replacement.sessionId };
      const originalTranscript = sessionAccessor.loadTranscriptEventsSync(scope);
      const replacementTranscript = sessionAccessor.loadTranscriptEventsSync(replacementScope);
      // The transcript owner reports a generation rebound as no append, not an
      // exception. Neither the old nor replacement conversation may gain input.
      await expect(persist()).resolves.toBeUndefined();
      expect(recorder.getAdmissionReceipt?.()).toBeUndefined();
      expect(loadSessionEntry(receipt.sessionKey).entry?.sessionId).toBe(replacement.sessionId);
      expect(sessionAccessor.loadTranscriptEventsSync(scope)).toEqual(originalTranscript);
      expect(sessionAccessor.loadTranscriptEventsSync(replacementScope)).toEqual(
        replacementTranscript,
      );
    } else {
      await expect(Promise.resolve().then(persist)).rejects.toThrow();
      expect(recorder.getAdmissionReceipt?.()).toBeUndefined();
    }
  } finally {
    release();
    await Promise.allSettled([dispatched, releaseWork]);
    for (const dispose of cleanup.toReversed()) {
      dispose();
    }
    signal.removeEventListener("abort", release);
  }
}
