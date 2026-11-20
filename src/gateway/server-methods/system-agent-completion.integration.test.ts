import fs from "node:fs/promises";
import { assert, expect, it } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { createOpenClawCodingToolsInternalAsync } from "../../agents/agent-tools.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.js";
import { validateAgentRunDelegatedAuthority } from "../../infra/agent-run-registry.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  createSystemAgentVerifiedInferenceTestFixture,
} from "../../system-agent/system-agent.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { createContext } from "../server-plugin-in-process-dispatch.test-support.js";
import { systemAgentHandlers } from "./system-agent.js";

// Exact config commands use the real tool, dispatch, human approval and persistent writer.
it("returns an approved change after its requesting run ends before result delivery", async (test) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (fixture) => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
        },
      },
      tools: { profile: "full", allow: ["openclaw"], openclaw: { autoApproveChanges: false } },
    };
    await fixture.writeConfig(config);
    setRuntimeConfigSnapshot(config);
    const sessionKey = "agent:main:approved-result";
    const sessionId = "approved-result-caller";
    replaceSessionEntrySync({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
    const operator = createAdmittedRunOperatorAuthority({
      profileId: GATEWAY_OWNER_PROFILE_ID,
      scopes: ["operator.admin"],
      assertCurrent: () => {},
    });
    const admission = prepareSystemAgentRunAdmission(
      config,
      "approved-result-run",
      "main",
      "approved-result-test",
      undefined,
      operator,
    );
    const manager = createTestApprovalManager<SystemAgentApprovalRequestPayload>(test, {
      approvalKind: "system-agent",
      resolveAllowedDecisions: (request) => request.allowedDecisions,
      validateAgentRuntimeDelegatedAuthority: validateAgentRunDelegatedAuthority,
    });
    const metadata = createSystemAgentPluginMetadataTestSnapshot(config);
    await metadata.run(async () => {
      const snapshot = await readConfigFileSnapshot();
      const inference = await createSystemAgentVerifiedInferenceTestFixture(config, snapshot);
      const engine = new SystemAgentChatEngine({
        surface: "gateway",
        operatorApprovalOnly: true,
        verifiedInference: inference.binding,
      });
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
      context.systemAgentSessions = new Map([
        [
          "approved-result",
          {
            engine,
            welcome: "Welcome",
            lastUsedAt: 1,
            ownerKey: JSON.stringify(["main", sessionKey]),
          },
        ],
      ]);
      context.systemAgentApprovalManager = manager;
      context.hasExecApprovalClients = () => true;
      const requested = createDeferred();
      let applied = false;
      context.broadcast = (event, payload) => {
        if (event === "openclaw.approval.requested") {
          requested.resolve();
        }
        if (
          event === "openclaw.approval.resolved" &&
          expect.objectContaining({ applicationStatus: "applied" }).asymmetricMatch(payload)
        ) {
          applied = true;
          // The approval owner has applied the change, but the waiting RPC has not resumed yet.
          admission.close();
        }
      };
      try {
        await withPluginRuntimeGatewayContextResolver(
          () => context,
          async () => {
            const caller = createAdmittedGatewayToolCallerIdentity({
              admittedRunContext: await admission.admit("embedded"),
              agentId: "main",
              sessionKey,
            });
            await withGatewayToolCallerIdentity(caller, async () => {
              const tools = await createOpenClawCodingToolsInternalAsync({
                config,
                agentId: "main",
                sessionKey,
                sessionId,
                workspaceDir: fixture.workspaceDir,
                senderIsOwner: true,
                pluginExecutionAuthority: operator,
                toolConstructionPlan: {
                  includeBaseCodingTools: false,
                  includeShellTools: false,
                  includeChannelTools: false,
                  includeOpenClawTools: true,
                  includePluginTools: false,
                },
              });
              const tool = tools.find((entry) => entry.name === "openclaw");
              assert(tool);
              const pending = tool.execute("approve-config-change", {
                message: "config set logging.level debug",
                sessionId: "approved-result",
              });
              try {
                await withinTest(
                  awaitGateBeforeSettlement(
                    requested.promise,
                    pending,
                    "human approval was not requested",
                  ),
                  test.signal,
                );
                const [record] = await manager.listPendingRecords();
                assert(record);
                expect(record.request.command).toContain("logging.level");
                await manager.resolve(record.id, "allow-once", "human-operator");
                const result = await pending;
                expect(applied).toBe(true);
                expect(
                  JSON.parse(await fs.readFile(fixture.configPath, "utf8")).logging.level,
                ).toBe("debug");
                expect(result.details).toMatchObject({
                  reply: expect.stringContaining("done: config.set"),
                });
              } finally {
                await manager.drain();
                await Promise.allSettled([pending]);
              }
            });
          },
        );
      } finally {
        admission.close();
        await engine.dispose();
      }
    }, config);
  });
});
