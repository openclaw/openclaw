import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import * as modelChoice from "../agents/model-runtime-choice.js";
import type { OpenClawToolsOptions } from "../agents/openclaw-tools.types.js";
import * as subagents from "../agents/subagents/registry/subagent-registry.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { bindGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";
import { createCoreGatewayMethodDescriptors } from "./methods/core-method-policy.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

vi.mock("../plugins/hook-runner-global.js", () => ({ getGlobalHookRunner: () => null }));
vi.mock("../agents/agent-tools.js", () => ({
  createOpenClawCodingTools: () => {
    throw new Error("This spawn-only MCP grant must not construct coding tools");
  },
}));
// Keep native spawn and both caller wrappers; unrelated tool factories do not serve this grant.
vi.mock("../agents/openclaw-tools.js", async () => {
  const { createSessionsSpawnTool } = await import("../agents/tools/sessions-spawn-tool.js");
  const { createGatewayToolCallerWrapper } =
    await import("../agents/tools/gateway-caller-context.js");
  const { filterToolsByClientCaps } = await import("../agents/openclaw-tools.client-caps.js");
  return {
    filterToolsByClientCaps,
    createOpenClawTools: (options: OpenClawToolsOptions) => [
      createGatewayToolCallerWrapper(
        options.requesterAgentIdOverride,
        options,
      )(
        createSessionsSpawnTool({
          agentSessionKey: options.runSessionKey ?? options.agentSessionKey,
          requesterAgentIdOverride: options.requesterAgentIdOverride,
          requesterRunId: options.runId,
          requesterTurnRunId: options.runId,
          completionOwnerKey: options.runSessionKey,
          agentChannel: options.agentChannel,
          config: options.sessionConfigSource === "runtime" ? undefined : options.config,
          requesterModel: options.requesterModel,
          sandboxed: options.sandboxed,
          sessionPermissionPolicy: options.sessionPermissionPolicy,
          inheritedToolAllowlist: options.inheritedToolAllowlist,
          inheritedToolDenylist: options.inheritedToolDenylist,
        }),
      ),
    ],
  };
});

it("retains only the admitted direct human requester through cached HTTP MCP tools and native creation", async ({
  signal,
}) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:discord:channel:maintainers";
    const storePath = state.path("sessions.json");
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      session: { store: storePath },
      agents: {
        defaults: { workspace: state.workspaceDir, model: "fixture/primary" },
        entries: { main: {} },
      },
      tools: { allow: ["sessions_spawn"] },
    };
    await state.writeConfig(cfg);
    setRuntimeConfigSnapshot(cfg);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey, storePath },
      {
        sessionId: "parent-session",
        updatedAt: 1,
      },
    );
    const prepareModel = vi.spyOn(modelChoice, "prepareModelChoice").mockResolvedValue({
      kind: "automatic",
      ref: { provider: "fixture", model: "primary" },
    });
    const registerRun = vi.spyOn(subagents, "registerSubagentRun").mockImplementation(() => {});
    const context = createContext();
    context.getRuntimeConfig = () => cfg;
    const creations: GatewayRequestHandlerOptions[] = [];
    context.getGatewayMethodRegistry = () =>
      createGatewayMethodRegistry(
        createCoreGatewayMethodDescriptors({
          "sessions.create": (request: GatewayRequestHandlerOptions) => {
            creations.push(request);
            request.respond(true, {
              key: "agent:main:dashboard:child",
              sessionId: "child-session",
              runStarted: true,
              runId: "child-run",
            });
          },
        }),
      );
    const port = await acquireTestPortBlock({ offsets: [0], signal });
    await runQaGatewayFixture(
      async () => {
        // Start outside any turn caller: each request must restore its own admitted source.
        await ensureMcpLoopbackServer(port.port);
        const runtime = expectDefined(getActiveMcpLoopbackRuntime(), "MCP runtime");
        for (const direct of [true, false]) {
          const runId = direct ? "human-request" : "synthetic-continuation";
          const operatorAuthority = createAdmittedRunOperatorAuthority({
            profileId: "person",
            scopes: ["operator.write"],
            assertCurrent: () => {},
          });
          const admission = prepareAgentRunAdmission({
            cfg,
            operatorAuthority,
            directHumanRequesterProfileId: direct ? "person" : undefined,
            operationalRunInstance: createOperationalRunInstanceRef(runId),
            facts: {
              runId,
              agentId: "main",
              ingress: {
                kind: direct ? "channel" : "system",
                boundary: "mcp-owner-proof",
                state: "present",
              },
            },
          });
          const admittedRunContext = await admission.admit("gateway");
          bindGatewayContextResolver(admittedRunContext, () => context);
          const grant = mintMcpLoopbackClientGrant({
            runtimeOwnerToken: runtime.ownerToken,
            admittedRunContext,
            context: {
              sessionKey,
              sessionId: "parent-session",
              runId,
              agentId: "main",
              senderIsOwner: false,
              messageProvider: "discord",
              inboundEventKind: "user_request",
              toolsAllow: ["sessions_spawn"],
            },
          });
          try {
            expect(
              activateMcpLoopbackClientGrantCapture({
                token: grant.token,
                runtimeOwnerToken: runtime.ownerToken,
                captureKey: runId,
              }),
            ).toBeDefined();
            for (const method of ["tools/list", "tools/call"]) {
              const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
                method: "POST",
                signal,
                headers: {
                  authorization: `Bearer ${grant.token}`,
                  "content-type": "application/json",
                  "x-openclaw-cli-capture-key": runId,
                },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: method,
                  method,
                  ...(method === "tools/call"
                    ? {
                        params: {
                          name: "sessions_spawn",
                          arguments: {
                            task: "Investigate dependency cycles",
                            visible: true,
                            expectsCompletionMessage: false,
                          },
                        },
                      }
                    : {}),
                }),
              });
              expect(response.status).toBe(200);
              const result = await response.json();
              expect(result).toMatchObject(
                method === "tools/list"
                  ? { result: { tools: [expect.objectContaining({ name: "sessions_spawn" })] } }
                  : { result: { isError: false } },
              );
            }
            expect(creations.at(-1)?.client?.internal?.sessionCreation?.requesterProfileId).toBe(
              direct ? "person" : undefined,
            );
            expect(creations.at(-1)?.params).not.toHaveProperty("requesterProfileId");
          } finally {
            revokeMcpLoopbackClientGrant(grant.token);
            admission.close();
          }
        }
        expect(creations).toHaveLength(2);
      },
      closeMcpLoopbackServer,
      port.release,
      () => prepareModel.mockRestore(),
      () => registerRun.mockRestore(),
    );
  });
});
