import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { bindWorkerToolPreparation } from "../agents/harness/host-private-capabilities.js";
import { bindPreparedToolAuthority } from "../agents/harness/tool-authority-preparation.js";
import { prepareOperatorModelPolicy } from "../agents/operator-model-policy.js";
import { runActiveReplySteer } from "../auto-reply/reply/agent-runner-steer-adoption.js";
import { createSteerParams } from "../auto-reply/reply/agent-runner-steer-adoption.test-support.js";
import { withMessageInjectionAdmission } from "../auto-reply/reply/message-injection-authority.js";
import { getFollowupQueueDepth } from "../auto-reply/reply/queue.js";
import { clearFollowupQueue } from "../auto-reply/reply/queue/state.js";
import { prepareReplyRunToolAuthority } from "../auto-reply/reply/reply-tool-authority.js";
import {
  createQueueTestRun,
  toolAuthorityOverlay,
} from "../auto-reply/reply/reply-tool-authority.test-support.js";
import { prepareSteeringDelivery } from "../auto-reply/reply/steering-delivery-preparation.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  registerSubagentCompletionToolHandoff,
  consumeSubagentCompletionToolHandoff,
} from "../gateway/subagent-completion-tool-handoff.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { withSessionTurn } from "./session-controller.admission.js";
import { captureReplyExecutionSelection } from "./session-controller.execution-selection.js";
import {
  beginReplyMessageInjectionTarget,
  captureReplyMessageInjectionTarget,
} from "./session-controller.message-injection.js";
import { prepareReplyMessageContinuation } from "./session-controller.message-join.js";
import { testing } from "./session-controller.test-support.js";

const dirs = useSessionStoreTempDirs(afterAll, "openclaw-continuation-handoff-");
const sessionId = "synthetic-handoff-parent";
const sessionKey = "agent:main:synthetic-handoff-parent";
const route = { provider: "openai", model: "synthetic-model" };
const outcomes: Record<string, { status: string; reason?: string }> = {
  "optional-completion": { status: "rejected", reason: "reply_expectation_mismatch" },
  "late-cohort-revocation": { status: "rejected", reason: "tool_authority_mismatch" },
  "late-source-and-cohort-revocation": { status: "failed" },
  "accepted-cohort-revocation": { status: "indeterminate" },
};
afterEach(() => {
  clearFollowupQueue(sessionKey);
  testing.resetSessionControllerForTest();
  clearRuntimeConfigSnapshot();
});
it.each([
  "plain-owner",
  "trusted-completion",
  "lower-scopes",
  "revoked-source",
  "revoked-cohort",
  "other-profile",
  "peer-owner",
  "late-cohort-revocation",
  "late-source-and-cohort-revocation",
  "accepted-cohort-revocation",
  "optional-completion",
] as const)(
  "joins a canonical completion execution without transferring its grant: %s",
  async (scenario) => {
    const storePath = path.join(dirs.make(), "sessions.json");
    const config = { session: { store: storePath }, tools: { allow: ["read", "exec"] } };
    setRuntimeConfigSnapshot(config);
    const sourceSessionKeys = [
      "agent:main:subagent:synthetic-first",
      "agent:main:subagent:synthetic-second",
    ] as const;
    await replaceSessionEntry({ storePath, sessionKey }, { sessionId, updatedAt: 1 });
    for (const key of sourceSessionKeys) {
      await replaceSessionEntry(
        { storePath, sessionKey: key },
        {
          sessionId: key + "-session",
          updatedAt: 1,
          spawnedBy: sessionKey,
          spawnDepth: 1,
          inheritedToolPolicyVersion: 1,
          inheritedToolAllow: ["read", "exec"],
          inheritedToolDeny: [],
        },
      );
    }
    let current = true;
    let sourceCurrent = true;
    const registration = {
      sourceSessionKey: sourceSessionKeys[0],
      targetSessionKey: sessionKey,
      targetSessionId: sessionId,
      idempotencyKey: "synthetic-settle-batch",
      settleBatch: { sourceSessionKeys, isCurrent: () => current },
    };
    const trustedInternalHandoff = consumeSubagentCompletionToolHandoff({
      ...registration,
      handoffId: registerSubagentCompletionToolHandoff(registration),
      sourceTool: "subagent_settle",
      ...route,
    });
    expect(trustedInternalHandoff).toBeDefined();
    const inputProvenance = {
      kind: "inter_session" as const,
      sourceTool: "subagent_settle",
      sourceSessionKey: sourceSessionKeys[0],
    };
    const isCompletion = scenario !== "plain-owner";
    const scopes = ["operator.admin", "operator.read", "operator.write"];
    const modelPolicy = prepareOperatorModelPolicy({ cfg: config, policy: {} });
    const authority = (incoming = false) =>
      createAdmittedRunOperatorAuthority({
        profileId: incoming && scenario === "other-profile" ? "synthetic-other" : "synthetic-owner",
        scopes: incoming && scenario === "lower-scopes" ? ["operator.read"] : scopes,
        gatewayAccessGrant: null,
        modelPolicy,
        assertCurrent() {
          if (incoming && (scenario === "revoked-source" || !sourceCurrent)) {
            throw new Error("Synthetic incoming authority revoked");
          }
        },
      });
    const entry: SessionEntry = { sessionId, updatedAt: 1 };
    const incumbent = createQueueTestRun({
      prompt: "Synthetic completion work",
      originatingChannel: "webchat",
    });
    incumbent.operatorAuthority = authority();
    Object.assign(incumbent.run, {
      agentId: "main",
      config,
      sessionId,
      sessionKey,
      sessionFile: path.join(path.dirname(storePath), "synthetic.jsonl"),
      workspaceDir: path.dirname(storePath),
      ...route,
      messageProvider: "webchat",
      messageChannel: "webchat",
      chatType: "direct",
      senderIsOwner: true,
      clientCaps: [],
      traceAuthorized: false,
      ...(isCompletion ? { inputProvenance, trustedInternalHandoff } : {}),
    });
    const frozenSelection = captureReplyExecutionSelection({
      run: incumbent.run,
      sessionEntry: entry,
    });
    await withSessionTurn(
      { sessionKey, sessionId, agentId: "main", storePath },
      async (operation) => {
        if (!operation) {
          throw new Error("Expected real handoff operation");
        }
        await operation.bindToolAuthoritySnapshotAsync(
          prepareReplyRunToolAuthority(incumbent, entry),
        );
        const fingerprint = await operation.bindToolAuthorityRouteAsync(incumbent.run);
        const sink = vi.fn();
        operation.attachBackend({
          kind: "embedded",
          toolAuthorityFingerprint: fingerprint,
          terminalReplyExpectation: scenario === "optional-completion" ? "optional" : "required",
          cancel() {},
          messageInjectionV2: {
            version: 2,
            isAvailable: () => true,
            async queueMessage() {
              throw new Error("Expected prepared owner admission");
            },
            async queueMessageAsync(text, options, preparation) {
              if (
                scenario === "late-cohort-revocation" ||
                scenario === "late-source-and-cohort-revocation"
              ) {
                current = false;
                sourceCurrent = scenario !== "late-source-and-cohort-revocation";
              }
              await withMessageInjectionAdmission(preparation.prepareCurrent, () => {
                preparation.assertCurrent();
                sink(text);
                options?.onQueueAccepted?.(true);
              });
              if (scenario === "accepted-cohort-revocation") {
                current = false;
                await preparation.prepareCurrent();
              }
            },
          },
        });
        operation.setPhase("running");
        const target = captureReplyMessageInjectionTarget(operation);
        if (!target) {
          throw new Error("Expected exact captured handoff target");
        }
        const incomingAuthority = authority(true);
        const incoming: typeof incumbent = {
          ...incumbent,
          operatorAuthority: incomingAuthority,
          prompt: "Synthetic human correction",
          run: { ...incumbent.run, inputProvenance: undefined, trustedInternalHandoff: undefined },
        };
        if (scenario === "peer-owner") {
          incoming.run.inputProvenance = {
            kind: "inter_session",
            sourceTool: "sessions_send",
            sourceSessionKey: sourceSessionKeys[0],
          };
          const runFollowup = vi.fn(async () => {});
          const admission = {};
          // Actual adapter computes isInboundUserMessage=false from real peer host provenance.
          // It must not create the human continuation merely because profile/sender match.
          await runActiveReplySteer(
            createSteerParams(sessionKey, incoming, operation, {
              runFollowup,
              steeringIntent: { kind: "continue-existing" },
              sessionEntry: entry,
              storePath,
              replyOperationRunState: admission,
              sessionCtx: { InputProvenance: incoming.run.inputProvenance },
            }),
          );
          expect(sink).not.toHaveBeenCalled();
          expect(getFollowupQueueDepth(sessionKey)).toBe(1);
          expect(runFollowup).not.toHaveBeenCalled();
          expect(incoming.run.trustedInternalHandoff).toBeUndefined();
          expect(incoming.run.inputProvenance).toMatchObject({
            kind: "inter_session",
            sourceTool: "sessions_send",
          });
          return;
        }
        if (scenario === "revoked-cohort") {
          current = false;
        }
        const {
          traceAuthorized: _trace,
          allowCollaborativeSteering: _collaboration,
          ...caller
        } = toolAuthorityOverlay(incoming);
        const delivery = prepareSteeringDelivery({
          agentId: "main",
          sessionKey,
          sessionId,
          storePath,
          entry,
          assertCurrent: () => incomingAuthority.assertCurrent(),
        });
        const prepare = () =>
          prepareReplyMessageContinuation({
            target,
            delivery,
            assertCurrent: () => incomingAuthority.assertCurrent(),
            input: {
              kind: "continuation",
              caller,
              config,
              executionSelection: frozenSelection,
              selectedRoute: route,
              fallbackAvailability: { kind: "none_configured", source: "inherited" },
            },
          });
        try {
          if (scenario === "revoked-source") {
            await expect(prepare()).rejects.toThrow("Synthetic incoming authority revoked");
            expect(sink).not.toHaveBeenCalled();
            return;
          }
          const prepared = await prepare();
          if (["lower-scopes", "other-profile", "revoked-cohort"].includes(scenario)) {
            expect(prepared.kind).not.toBe("prepared");
            expect(sink).not.toHaveBeenCalled();
            return;
          }
          expect(prepared.kind).toBe("prepared");
          if (prepared.kind !== "prepared") {
            throw new Error("Expected owner-prepared completion join");
          }
          try {
            const injection = await beginReplyMessageInjectionTarget(target, incoming.prompt, {
              assertCurrent: () => incomingAuthority.assertCurrent(),
              isInboundUserMessage: true,
              terminalReplyExpectation: "required",
              toolAuthorityFingerprint: prepared.fingerprint,
              toolAuthorityPreparation: bindPreparedToolAuthority(
                bindWorkerToolPreparation({
                  authorityKind: "source-bound" as const,
                  assertCurrent: () => prepared.read(),
                  compatAssertCurrent: () => prepared.read(),
                  prepareCurrent: prepared.prepareCurrent,
                }),
              ),
            });
            const result = await injection.outcome;
            expect(result).toMatchObject(outcomes[scenario] ?? { status: "accepted" });
            if (scenario === "late-cohort-revocation") {
              expect(result).toHaveProperty("errorMessage");
            }
            if (
              scenario === "late-cohort-revocation" ||
              scenario === "late-source-and-cohort-revocation"
            ) {
              expect(await injection.acceptance).toBe(false);
            } else if (scenario === "accepted-cohort-revocation") {
              expect(await injection.acceptance).toBe(true);
            }
            expect(sink).toHaveBeenCalledTimes(
              ["plain-owner", "trusted-completion", "accepted-cohort-revocation"].includes(scenario)
                ? 1
                : 0,
            );
            // Neither the message nor fallback data acquires the incumbent's canonical handoff.
            expect(incoming.run.inputProvenance).toBeUndefined();
            expect(incoming.run.trustedInternalHandoff).toBeUndefined();
            expect(operation.toolAuthorityFingerprint).toBe(fingerprint);
          } finally {
            prepared.release();
          }
        } finally {
          delivery.release();
        }
      },
    );
  },
);
