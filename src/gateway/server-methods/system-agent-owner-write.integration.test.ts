import fs from "node:fs/promises";
import { afterEach, assert, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
} from "../../agents/admitted-run-context.js";
import { createOpenClawCodingToolsInternalAsync } from "../../agents/agent-tools.js";
import { createAgentTurnTaintState } from "../../agents/embedded-agent-runner/run/turn-taint-state.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createSystemAgentTool } from "../../agents/tools/system-agent-tool.js";
import * as configValidation from "../../cli/config-cli-validation.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import type { SystemAgentTurnRunner } from "../../system-agent/agent-turn.js";
import { SystemAgentChatEngine } from "../../system-agent/chat-engine.js";
import {
  createSystemAgentPluginMetadataTestSnapshot,
  createSystemAgentVerifiedInferenceTestFixture,
} from "../../system-agent/system-agent.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createContext } from "../server-plugin-in-process-dispatch.test-support.js";
import { systemAgentHandlers } from "./system-agent.js";

afterEach(() => vi.restoreAllMocks());

// Synthetic inference chooses an operation; dispatch, approval, validation and persistence are real.
it.for(["active", "revoked", "non-owner"] as const)(
  "preserves the %s source grant through delegated role persistence after a network read",
  (state, { signal }) =>
    withOpenClawTestState({ scenario: "minimal" }, async (fixture) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            model: "openai/gpt-5.5",
            models: { "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } } },
          },
        },
        tools: {
          profile: "full",
          allow: ["openclaw"],
          exec: { host: "gateway", security: "full", ask: "off" },
        },
        gateway: {
          roles: {
            default: "contributor",
            definitions: {
              contributor: { sessions: { others: "none" }, agents: "*", scopes: ["operator.read"] },
            },
          },
        },
      };
      await fixture.writeConfig(config);
      const original = await fs.readFile(fixture.configPath, "utf8");
      setRuntimeConfigSnapshot(config);
      const sessionKey = "agent:main:owner-role-write";
      const sessionId = "owner-role-write-session";
      replaceSessionEntrySync({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
      const lifetime = new AbortController();
      const authority = createAdmittedRunOperatorAuthority({
        profileId: GATEWAY_OWNER_PROFILE_ID,
        scopes: ["operator.admin"],
        signal: lifetime.signal,
        assertCurrent: () => lifetime.signal.throwIfAborted(),
      });
      const operationalRunInstance = createOperationalRunInstanceRef("owner-role-write-run");
      const approvalAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      const taint = createAgentTurnTaintState();
      const metadata = createSystemAgentPluginMetadataTestSnapshot(config);
      await metadata.run(async () => {
        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.valid, JSON.stringify(snapshot.issues)).toBe(true);
        const proof = await createSystemAgentVerifiedInferenceTestFixture(
          snapshot.runtimeConfig,
          snapshot,
        );
        const inference = vi.fn<SystemAgentTurnRunner>(async (params) => {
          const result = await createSystemAgentTool({
            surface: "gateway",
            operatorApprovalOnly: true,
            proposalRef: params.session.proposalRef,
          }).execute("synthetic-config-proposal", {
            action: "config_set",
            path: "gateway.roles.assignments.byGithubLogin.fixture-contributor",
            value: "contributor",
          });
          expect(result.details).toMatchObject({ needsApproval: true });
          return { text: "Proposed the requested fixture role assignment." };
        });
        const engine = new SystemAgentChatEngine({
          surface: "gateway",
          operatorApprovalOnly: true,
          verifiedInference: proof.binding,
          runAgentTurn: inference,
        });
        const handler = vi.fn(systemAgentHandlers["openclaw.chat"]!);
        const context = createContext(
          [["openclaw.chat", "operator.admin", "system-agent", handler]],
          () => config,
        );
        context.resolveGatewayContext = () => context;
        context.systemAgentSessions = new Map([
          [
            "fixture-delegation",
            {
              engine,
              welcome: "Synthetic welcome",
              lastUsedAt: 1,
              ownerKey: JSON.stringify(["main", sessionKey]),
            },
          ],
        ]);
        const prepared = createDeferred();
        const release = createDeferred();
        const validate = configValidation.validateConfigMutation;
        // Observe and pause the real validation result, after approval and before persistence.
        const validation = vi
          .spyOn(configValidation, "validateConfigMutation")
          .mockImplementation(async (...args) => {
            const result = await validate(...args);
            prepared.resolve();
            await release.promise;
            return result;
          });
        try {
          await withPluginRuntimeGatewayContextResolver(
            () => context,
            () =>
              withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey,
                  operationalRunInstance,
                  approvalAuthority,
                  operatorAuthority: authority,
                  receiptAuthority: authority.assertCurrent,
                  gatewayContextResolver: () => context,
                },
                async () => {
                  const tools = await createOpenClawCodingToolsInternalAsync({
                    config,
                    agentId: "main",
                    sessionKey,
                    sessionId,
                    workspaceDir: fixture.workspaceDir,
                    senderIsOwner: state !== "non-owner",
                    pluginExecutionAuthority: authority,
                    isTurnTainted: taint.isTainted,
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
                  taint.observe({
                    toolName: "web_fetch",
                    argsHash: "fixture-github-request",
                    resultHash: "fixture-github-response",
                    resultContentSource: "network",
                  });
                  const pending = tool.execute("assign-fixture-role", {
                    message: "Assign fixture-contributor the contributor role.",
                    sessionId: "fixture-delegation",
                  });
                  if (state === "non-owner") {
                    expect(JSON.stringify(await pending)).toContain("gated");
                    expect(handler).not.toHaveBeenCalled();
                    expect(inference).not.toHaveBeenCalled();
                  } else {
                    try {
                      await withinTest(
                        awaitGateBeforeSettlement(
                          prepared.promise,
                          pending,
                          "delegated config validation was not reached",
                        ),
                        signal,
                      );
                      expect(handler).toHaveBeenCalledOnce();
                      expect(validation).toHaveBeenCalledOnce();
                      expect(await fs.readFile(fixture.configPath, "utf8")).toBe(original);
                      if (state === "revoked") {
                        lifetime.abort(new Error("Original operator grant revoked"));
                      }
                    } finally {
                      release.resolve();
                    }
                    if (state === "revoked") {
                      await expect(pending).rejects.toThrow(/revoked/);
                    } else {
                      expect(JSON.stringify(await pending)).toContain("done: config.set");
                    }
                    await Promise.allSettled(handler.mock.results.map((result) => result.value));
                  }
                  expect(taint.isTainted()).toBe(true);
                  const saved = await fs.readFile(fixture.configPath, "utf8");
                  if (state === "active") {
                    expect(JSON.parse(saved).gateway.roles.assignments.byGithubLogin).toEqual({
                      "fixture-contributor": "contributor",
                    });
                  } else {
                    expect(saved).toBe(original);
                    expect(JSON.parse(saved).gateway.roles.assignments).toBeUndefined();
                  }
                },
              ),
          );
        } finally {
          release.resolve();
          await engine.dispose();
          releaseAgentRunDelegatedAuthority(approvalAuthority);
        }
      }, config);
    }),
);
