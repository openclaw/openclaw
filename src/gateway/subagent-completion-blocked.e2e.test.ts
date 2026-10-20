import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createRestartRecoveryOperatorSource } from "../agents/operator-run-recovery-source.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "../agents/subagents/registry/subagent-lifecycle-events.js";
import { observeRootWork } from "../agents/subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import {
  addSubagentRunForTests,
  getSubagentRunByRunId,
  resetSubagentRegistryForTests,
  resumeSubagentRun,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { getGatewayContextResolver } from "../plugins/runtime/gateway-context-binding.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import { getGatewayRecoveryRuntime } from "./server-recovery-runtime-context.js";
import {
  installGatewayTestHooks,
  testState,
  withGatewayServer,
  writeSessionStore,
} from "./test-helpers.js";

vi.mock("../agents/subagents/announce/subagent-announce.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/subagents/announce/subagent-announce.js")>()),
  runSubagentAnnounceFlow: async () => "retryable",
}));
vi.mock("../agents/subagents/announce/subagent-announce.requester-settle-wake.js", () => ({
  maybeWakeRequesterAfterAllChildrenSettled: async () => false,
}));

installGatewayTestHooks({ scope: "suite" });

it("suspends native completion delivery after its one recorded failure", async () => {
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
  const stateDir = expectDefined(process.env.OPENCLAW_STATE_DIR, "Gateway E2E state dir");
  const configPath = expectDefined(process.env.OPENCLAW_CONFIG_PATH, "Gateway E2E config path");
  testState.sessionStorePath = path.join(stateDir, "sessions.sqlite");
  try {
    // Keep unrelated reload roots out of the completion settlement barrier.
    await fs.writeFile(configPath, JSON.stringify({ gateway: { reload: { mode: "off" } } }));
    await withGatewayServer(async () => {
      const now = Date.now();
      const endedAt = now - 31 * 60_000;
      const subagent = createSubagentRunRecord({
        runId: "subagent-run-blocked-gateway-e2e",
        childSessionKey: "agent:main:subagent:blocked-gateway-e2e",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "agent:main:main",
        requesterAgentId: "main",
        task: "finish the Gateway exhaustion proof",
        createdAt: endedAt - 1_000,
        endedAt,
        endedReason: SUBAGENT_ENDED_REASON_COMPLETE,
        outcome: { status: "ok" },
        expectsCompletionMessage: true,
        completion: { required: true, resultText: "proof result", capturedAt: endedAt },
        delivery: {
          status: "pending",
          disposition: "retryable",
          generation: 1,
          windowStartedAt: endedAt,
          deadlineAt: endedAt + 30 * 60_000,
          lastError: "requester unavailable",
        },
      });

      const entry = (sessionId: string) => ({ sessionId, updatedAt: now });
      await writeSessionStore({
        agentId: "main",
        entries: {
          [subagent.requesterSessionKey]: entry("requester-blocked-gateway-e2e"),
          [subagent.childSessionKey]: entry("session-blocked-gateway-e2e"),
        },
      });
      const readEntry = (sessionKey: string) =>
        expectDefined(
          loadExactSessionEntryReadOnly({
            agentId: "main",
            storePath: testState.sessionStorePath,
            sessionKey,
          })?.entry,
          `persisted session ${sessionKey}`,
        );
      const sessionEntry = readEntry(subagent.childSessionKey);
      const requester = readEntry(subagent.requesterSessionKey);
      const runtime = expectDefined(getGatewayRecoveryRuntime(), "live Gateway runtime");
      const context = expectDefined(getGatewayContextResolver(runtime)?.(), "live Gateway context");
      const config = context.getCommittedRuntimeConfig?.() ?? context.getRuntimeConfig();
      const client = createOperatorClient({
        profileName: "completion-expiry-operator",
        scopes: ["operator.write"],
      });
      // Model the authenticated handshake; production admission captures its recovery source.
      client.internal = { authenticatedOperator: true };
      client.authPolicy = captureGatewayAuthPolicy(config, {
        role: "operator",
        authMethod: "token",
      });
      const captured = expectDefined(
        await captureGatewayOperatorRunAuthority({
          client: expectDefined(captureAgentTurnPrincipal(client), "operator principal"),
          context,
          sourceAuthority: null,
        }),
        "admitted original operator",
      );
      try {
        const operatorRecoverySource = expectDefined(
          createRestartRecoveryOperatorSource({
            authority: captured.authority,
            entry: requester,
            agentId: "main",
            sessionKey: subagent.requesterSessionKey,
            sourceRunId: "completion-expiry-requester-turn",
          }),
          "host-captured original operator source",
        );
        await addSubagentRunForTests({
          ...subagent,
          requesterStorePath: testState.sessionStorePath,
          completionRequesterSessionId: requester.sessionId,
          completionRequesterLifecycleRevision: requester.lifecycleRevision,
          operatorRecoverySource,
          childAgentId: "main",
          childSessionIdentity: {
            sessionId: sessionEntry.sessionId,
            lifecycleRevision: sessionEntry.lifecycleRevision,
          },
        });
      } finally {
        captured.release();
      }

      // Native suspension completes in detached work. Join its owner before
      // asserting or closing the Gateway, including cold worker startup.
      const settleRootWork = observeRootWork();
      try {
        resumeSubagentRun(subagent.runId);
      } finally {
        await settleRootWork();
      }

      expect(getSubagentRunByRunId(subagent.runId)?.delivery).toMatchObject({
        status: "suspended",
        disposition: "permanent_failure",
        suspendedReason: "expiry",
      });
    });
  } finally {
    await resetSubagentRegistryForTests({ persist: false });
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "1";
  }
});
