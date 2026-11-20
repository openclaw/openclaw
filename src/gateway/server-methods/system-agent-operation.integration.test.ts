import { afterEach, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
} from "../../agents/admitted-run-context.js";
import { filterRuntimeCompatibleTools } from "../../agents/tool-schema-projection.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createOpenClawDelegateToolsForRun } from "../../agents/tools/openclaw-delegate-tool.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import * as inference from "../../system-agent/inference-fallback.js";
import {
  createSystemAgentTranscriptStore,
  readTranscriptTailAsync,
} from "../../system-agent/transcript-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createPreparedTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { createContext } from "../server-plugin-in-process-dispatch.test-support.js";
import { systemAgentHandlers } from "./system-agent.js";
import { listSystemChanges } from "./system-changes.js";

afterEach(() => vi.restoreAllMocks());

// Real tool, Gateway admission, approval policy, operation executor and config writer.
// No provider is configured: exact configuration must not need a helper conversation.
it.for([
  "automatic",
  "allow-once",
  "deny",
  "expired",
  "cancelled",
  "unprivileged",
  "invalid",
  "policy",
] as const)(
  "settles the regular agent's typed config request through its existing authority: %s",
  async (decision, test) =>
    withOpenClawTestState({ scenario: "minimal" }, async (fixture) => {
      const requiresApproval = ["allow-once", "deny", "expired", "cancelled", "policy"].includes(
        decision,
      );
      const policyChange = decision === "policy";
      const targetPath = policyChange ? "tools.openclaw.autoApproveChanges" : "logging.level";
      const config: OpenClawConfig = {
        agents: { defaults: { workspace: fixture.workspaceDir } },
        logging: { level: "info" },
        tools: {
          exec: { host: "gateway", mode: "full" },
          ...(policyChange ? {} : { openclaw: { autoApproveChanges: !requiresApproval } }),
        },
      };
      await fixture.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      const previousTurn = { role: "assistant" as const, text: "Earlier setup history.", at: 1 };
      await createSystemAgentTranscriptStore().appendTurn(previousTurn);
      const verify = vi
        .spyOn(inference, "verifySystemAgentInferenceWithFallback")
        .mockRejectedValue(new Error("A typed config operation must not request helper inference"));
      const context = createContext(
        [
          [
            "openclaw.chat",
            "operator.admin",
            "system-agent",
            systemAgentHandlers["openclaw.chat"]!,
          ],
        ],
        () => config,
      );
      context.resolveGatewayContext = () => context;
      context.systemAgentSessions = new Map();
      const executions: Promise<unknown>[] = [];
      const track = context.trackExecution;
      context.trackExecution = (run) => {
        const execution = track(run);
        executions.push(execution);
        return execution;
      };
      const requested = createDeferred();
      context.broadcast = (event) => {
        if (event === "openclaw.approval.requested") {
          requested.resolve();
        }
      };
      context.broadcastToConnIds = () => {};
      context.hasExecApprovalClients = () => true;
      const approvals = requiresApproval
        ? await createPreparedTestApprovalManager<SystemAgentApprovalRequestPayload>(test, {
            approvalKind: "system-agent",
            resolveAllowedDecisions: (request) => request.allowedDecisions,
            validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
          })
        : undefined;
      context.systemAgentApprovalManager = approvals?.manager;
      const sessionKey = "agent:main:typed-config";
      const operationalRunInstance = createOperationalRunInstanceRef("typed-config-request");
      const approvalAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const controller = new AbortController();
      try {
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey,
            operationalRunInstance,
            approvalAuthority,
            receiptAuthority: () => true,
            gatewayContextResolver: () => context,
            ...(decision === "unprivileged"
              ? {
                  operatorAuthority: createAdmittedRunOperatorAuthority({
                    profileId: GATEWAY_OWNER_PROFILE_ID,
                    scopes: ["operator.read"],
                    assertCurrent: () => {},
                  }),
                }
              : {}),
          },
          async () => {
            const [tool] = createOpenClawDelegateToolsForRun({
              config,
              sessionAgentId: "main",
              runSessionKey: sessionKey,
              delegationExecAuthority: () => "gateway-host",
            });
            expect(tool).toBeDefined();
            expect(filterRuntimeCompatibleTools([tool!]).diagnostics).toEqual([]);
            const pending = tool!.execute(
              "typed-config",
              {
                action: "config_set",
                path: targetPath,
                value: policyChange ? "true" : decision === "invalid" ? "not-a-level" : "debug",
                // A model assertion is not approval, even when directly invoking the tool.
                approved: true,
              },
              controller.signal,
            );
            if (decision === "unprivileged") {
              await expect(pending).rejects.toThrow("operator.admin");
              return;
            }
            if (approvals) {
              await awaitGateBeforeSettlement(
                requested.promise,
                pending,
                "exact approval was not requested",
              );
              expect((await readConfigFileSnapshot()).sourceConfig.logging?.level).toBe("info");
              const [record] = await approvals.manager.listPendingRecords();
              expect(record?.request).toMatchObject({ agentId: "main", sessionKey });
              expect(record?.request.description).toContain(targetPath);
              if (decision === "cancelled") {
                const stopped = new Error("requesting tool stopped");
                const rejected = pending.catch((error: unknown) => error);
                controller.abort(stopped);
                const error = await rejected;
                await Promise.allSettled(executions);
                expect(error).toMatchObject({
                  message: "agent tool caller authority is no longer active",
                });
                expect((await approvals.manager.getSnapshot(record!.id))?.status).toBe("cancelled");
                expect(
                  await approvals.manager.resolve(record!.id, "allow-once", "late-operator"),
                ).toBe(false);
                return;
              }
              if (decision === "expired") {
                await approvals.manager.expire(record!.id);
              } else {
                await approvals.manager.resolve(
                  record!.id,
                  decision === "allow-once" ? "allow-once" : "deny",
                  "operator-ui",
                );
              }
            }
            const result = await pending;
            const expected =
              decision === "automatic" || decision === "allow-once"
                ? "Completed only config.set"
                : decision === "expired"
                  ? "expired"
                  : decision === "invalid"
                    ? "The config write failed"
                    : "Denied";
            expect(JSON.stringify(result)).toContain(expected);
          },
        );
        await Promise.allSettled(executions);
        const applied = decision === "automatic" || decision === "allow-once";
        expect((await readConfigFileSnapshot()).sourceConfig.logging?.level).toBe(
          applied ? "debug" : "info",
        );
        if (policyChange) {
          expect(
            (await readConfigFileSnapshot()).sourceConfig.tools?.openclaw?.autoApproveChanges,
          ).toBeUndefined();
        }
        expect(verify).not.toHaveBeenCalled();
        const changes = await listSystemChanges({ limit: 10 });
        const operations = changes.entries.filter((entry) => entry.kind === "operation");
        expect(operations).toHaveLength(applied ? 1 : 0);
        if (applied) {
          expect(operations[0]?.summary).toBe("Set config logging.level");
        }
        expect(await readTranscriptTailAsync(100)).toEqual([previousTurn]);
        expect(context.systemAgentSessions.size).toBe(0);
      } finally {
        controller.abort();
        // Let the real cancellation handoff settle before retiring its approval manager.
        await Promise.allSettled(executions);
        await approvals?.manager.drain();
        releaseAgentRunDelegatedAuthority(approvalAuthority);
        await Promise.all(
          [...context.systemAgentSessions.values()].map((session) => session.engine.dispose()),
        );
      }
    }),
);
