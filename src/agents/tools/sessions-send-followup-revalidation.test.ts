import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { prepareGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import * as runs from "../../infra/agent-run-registry.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { captureSessionTarget } from "../../sessions/session-controller.lifecycle.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../cron-creator-authority-context.js";
import { runAnnounceAgentCall } from "../subagents/announce/subagent-announce-completion-delivery.js";
import { loadRequesterSessionEntry } from "../subagents/announce/subagent-announce-delivery.runtime.js";
import { testing } from "../subagents/announce/subagent-announce-delivery.test-support.js";
import { revokeRequesterCronAuthority } from "../subagents/requester-cron-authority.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { prepareSessionsSendFollowup } from "./sessions-send-followup-custody.js";

it.each([
  "unchanged",
  "revision",
  "policy",
  "revoked",
  "unchanged while blocked",
  "revision while blocked",
] as const)("revalidates a retained requester completion after %s", async (change) => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const cfg = { commands: { ownerAllowFrom: ["telegram:synthetic-owner"] } };
    setRuntimeConfigSnapshot(cfg);
    const requesterSessionKey = "agent:main:requester-authority-retry";
    const targetSessionKey = "agent:main:subagent:authority-retry";
    const requester = { sessionId: "requester", lifecycleRevision: "before", updatedAt: 1 };
    await replaceSessionEntry({ agentId: "main", sessionKey: requesterSessionKey }, requester);
    await replaceSessionEntry(
      { agentId: "main", sessionKey: targetSessionKey },
      {
        sessionId: "child",
        lifecycleRevision: "child",
        updatedAt: 1,
      },
    );
    const context = createContext([], () => cfg);
    context.resolveGatewayContext = () => context;
    const client = createOperatorClient({
      profileName: "synthetic-requester-retry",
      scopes: ["operator.admin"],
    });
    const source = await prepareGatewayOperatorRunAuthority({ client, context });
    if (!source) {
      throw new Error("Requester completion requires admitted operator authority");
    }
    client.internal = { operatorRunAuthority: source.authority };
    const capability = createCronCreatorAuthorityCapability(
      "parent",
      { kind: "unknown" },
      { source: "channel-owner" },
      () => true,
      undefined,
      { senderId: "synthetic-owner", channel: "telegram" },
    )!;
    const { operationalRunInstance } = createTestAdmittedRunContext("parent");
    const approvalAuthority = runs.claimAgentRunDelegatedAuthority(operationalRunInstance);
    runs.registerAgentRunContext("parent", {
      agentId: "main",
      sessionKey: requesterSessionKey,
      sessionId: requester.sessionId,
    });
    let request: Awaited<ReturnType<typeof prepareSessionsSendFollowup>> = undefined;
    try {
      request = await withPluginRuntimeGatewayRequestScope(
        {
          client,
          context,
          resolveGatewayContext: context.resolveGatewayContext,
          isWebchatConnect: () => false,
        },
        () =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: requesterSessionKey,
              operationalRunInstance,
              approvalAuthority,
              receiptAuthority: () => {
                if (!runs.validateAgentRunDelegatedAuthority(approvalAuthority)) {
                  throw new Error("agent tool caller authority is no longer active");
                }
              },
            },
            () =>
              runWithCronCreatorAuthorityCapability(capability, () =>
                prepareSessionsSendFollowup({
                  runId: "child",
                  requesterTurnRunId: "parent",
                  requesterAgentId: "main",
                  requesterSessionKey,
                  targetAgentId: "main",
                  targetSessionKey,
                  withRequesterAuthority: (work) => work(),
                }),
              ),
          ),
      );
      expect(request?.requesterAuthority).toBeDefined();
      const attempt = () => request!.requesterAuthority!.run("completion", async () => "accepted");
      await expect(attempt()).resolves.toBe("accepted");
      if (change === "revision" || change === "revision while blocked") {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: requesterSessionKey },
          { ...requester, updatedAt: 2, label: "Progress after retaining completion" },
        );
      } else if (change === "policy") {
        setRuntimeConfigSnapshot({
          ...cfg,
          gateway: {
            roles: {
              definitions: {
                guest: {
                  agents: "*",
                  scopes: [],
                  sessions: { others: "none" },
                  modelPolicy: { allow: ["synthetic/model"] },
                },
              },
            },
          },
        });
      } else if (change === "revoked") {
        setRuntimeConfigSnapshot({
          ...cfg,
          commands: { ownerAllowFrom: ["telegram:different-owner"] },
        });
      }
      if (change === "revision while blocked" || change === "unchanged while blocked") {
        const loaded = await loadRequesterSessionEntry(requesterSessionKey, "main");
        const target = captureSessionTarget({
          storeScope: loaded.storePath!,
          physicalStorePath: loaded.physicalStorePath,
          sessionKey: requesterSessionKey,
          agentId: "main",
          incarnation: requester.sessionId,
        });
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const blocker = withSessionTurn(
          { target, sessionKey: requesterSessionKey, sessionId: requester.sessionId },
          async () => {
            entered.resolve();
            await release.promise;
          },
        );
        await entered.promise;
        const input = reserveSessionControllerSource(requesterSessionKey, {
          target,
          policy: { mode: "followup" },
          continuationCaller: {
            run: (work) => request!.requesterAuthority!.run("completion", work),
          },
        });
        const callGateway = vi
          .fn<typeof import("../../gateway/call.js").callGateway>()
          .mockResolvedValue({
            status: "ok",
            inputProcessingCompleted: true,
          });
        testing.setDepsForTest({ callGateway });
        const dispatchEntered = createDeferredCore();
        const delivery = runAnnounceAgentCall({
          agentParams: {
            sessionKey: requesterSessionKey,
            idempotencyKey: "completion",
            message: "synthetic result",
          },
          controllerInput: input,
          privateCompletion: true,
          isExecutionAllowed: () => true,
          onBeforeDispatch: () => {
            dispatchEntered.resolve();
          },
        });
        try {
          await Promise.race([dispatchEntered.promise, delivery]);
          expect(input.phase).toBe("waiting");
          vi.useFakeTimers({ toFake: ["Date"] });
          const started = Date.now();
          vi.setSystemTime(started + 900_000);
          expect(callGateway).not.toHaveBeenCalled();
          release.resolve();
          await blocker;
          await delivery;
          expect(callGateway).toHaveBeenCalledOnce();
          expect(Date.now() - started).toBe(900_000);
        } finally {
          release.resolve();
          await blocker;
          await delivery.catch(() => {});
          retireSessionControllerInput(input);
          testing.setDepsForTest();
          vi.useRealTimers();
        }
      } else {
        await expect(attempt()).resolves.toBe("accepted");
      }
    } finally {
      revokeRequesterCronAuthority(requesterSessionKey);
      request?.custody.release();
      runs.releaseAgentRunDelegatedAuthority(approvalAuthority);
      runs.clearAgentRunContext("parent");
      source.release();
    }
  });
});
