import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "../../config/sessions/session-accessor.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import * as runs from "../../infra/agent-run-registry.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { prepareSessionsSendFollowup } from "./sessions-send-followup-custody.js";

it.each([
  "unchanged",
  "revision",
  "native reset",
  "revoked",
  "replacement",
  "target revision",
] as const)("readmits a retained requester completion after %s", async (change) => {
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
    let gatewayCurrent = true;
    context.resolveGatewayContext = () => (gatewayCurrent ? context : undefined);
    const client = createOperatorClient({
      profileName: "synthetic-requester-retry",
      scopes: ["operator.admin"],
    });
    const source = await captureGatewayOperatorRunAuthority({ client, context });
    expect(source).toBeDefined();
    client.internal = { operatorRunAuthority: source!.authority };
    const { operationalRunInstance } = createTestAdmittedRunContext("parent");
    const approvalAuthority = runs.claimAgentRunDelegatedAuthority(operationalRunInstance);
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
              receiptAuthority: () => runs.validateAgentRunDelegatedAuthority(approvalAuthority),
            },
            () =>
              prepareSessionsSendFollowup({
                runId: "child",
                requesterAgentId: "main",
                requesterSessionKey,
                targetAgentId: "main",
                targetSessionKey,
              }),
          ),
      );
      expect(request).toBeDefined();
      const attempt = () => request!.custody.run(() => "accepted");
      expect(attempt()).toBe("accepted");
      if (change === "revision") {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: requesterSessionKey },
          { ...requester, lifecycleRevision: "after" },
        );
      } else if (change === "native reset") {
        await resetSessionEntryLifecycle({
          agentId: "main",
          storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
          target: { canonicalKey: requesterSessionKey, storeKeys: [requesterSessionKey] },
          buildNextEntry: ({ currentEntry }) => {
            if (!currentEntry) {
              throw new Error("Expected requester session to exist before reset");
            }
            return { ...currentEntry, lifecycleRevision: "after-reset", updatedAt: 2 };
          },
        });
      } else if (change === "replacement") {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: requesterSessionKey },
          {
            ...requester,
            sessionId: "replacement",
            lifecycleRevision: "after",
          },
        );
      } else if (change === "target revision") {
        await replaceSessionEntry(
          { agentId: "main", sessionKey: targetSessionKey },
          {
            sessionId: "child",
            lifecycleRevision: "after",
            updatedAt: 2,
          },
        );
      } else if (change === "revoked") {
        gatewayCurrent = false;
      }
      if (change === "revoked" || change === "replacement" || change === "target revision") {
        expect(attempt).toThrow();
      } else {
        expect(attempt()).toBe("accepted");
      }
    } finally {
      request?.custody.release();
      runs.releaseAgentRunDelegatedAuthority(approvalAuthority);
      source?.release();
    }
  });
});
