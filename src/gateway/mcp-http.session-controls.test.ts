import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../agents/admitted-run-context.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import * as inProcessGateway from "../agents/tools/in-process-gateway.js";
import type { CliDeps } from "../cli/deps.types.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { assignSessionOwner } from "../config/sessions/session-accessor.sqlite-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { LegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { setUserProfileRole } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintMcpLoopbackClientGrant,
  resolveMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";
import { McpLoopbackToolCache } from "./mcp-http.runtime.js";
import {
  readOperatorToolGatewayAuthority,
  runOutsideOperatorToolGatewayAuthority,
} from "./operator-tool-gateway-authority.js";
import { withOperatorToolGatewayAuthority } from "./server-plugin-in-process-dispatch.js";
import { roleClient, rolePolicyConfig } from "./session-sharing.test-utils.js";

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: async () => {},
}));

const requesterKey = "agent:main:dashboard:mcp-archive-requester";
const targetKey = "agent:main:dashboard:mcp-archive-target";
const targetId = "mcp-archive-target-id";

// The dispatch cases are in-process boundary proof, not HTTP transport proof.
// HTTP runs the same final-effect assertions through the real bearer-bound server.
for (const transport of ["dispatch", "HTTP"] as const) {
  it.each(["allowed", "assigned-noncreator", "reassigned", "profile-revoked", "replaced"] as const)(
    `MCP ${transport} preserves archive final-effect authority: %s`,
    async (scenario) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const cfg: OpenClawConfig = {
          ...rolePolicyConfig(),
          agents: { entries: { main: { workspace: state.workspaceDir } } },
          tools: { sessions: { visibility: "all" } },
        };
        await state.writeConfig(cfg);
        const client = roleClient("write");
        const profile = expectDefined(client.authenticatedUserProfile, "operator profile");
        for (const [sessionKey, sessionId, creator] of [
          [requesterKey, "mcp-archive-requester-id", profile.profileId],
          [
            targetKey,
            targetId,
            scenario === "assigned-noncreator" ? "other-person" : profile.profileId,
          ],
        ] as const) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey },
            {
              sessionId,
              updatedAt: 1,
              visibility: "shared",
              createdActor: { type: "human", source: "profile", id: creator },
            },
          );
        }
        assignSessionOwner(
          { agentId: "main", sessionKey: targetKey },
          {
            owner: { type: "human", id: profile.profileId },
            assignedBy: { type: "human", id: profile.profileId },
          },
        );
        const resources = new LegacyPluginSdkResourceHost();
        try {
          await resources.run(() =>
            withLocalGatewayRequestScope(
              { deps: {} as CliDeps, getRuntimeConfig: () => cfg },
              async () => {
                // Server creation is outside the individual operator invocation.
                await ensureMcpLoopbackServer();
                try {
                  const scope = expectDefined(
                    getPluginRuntimeGatewayRequestScope(),
                    "local Gateway request scope",
                  );
                  await withPluginRuntimeGatewayRequestScope({ ...scope, client }, () =>
                    withOperatorToolGatewayAuthority(
                      {
                        authenticatedUserProfile: profile,
                        scopes: ["operator.write"],
                      },
                      async () => {
                        const operatorAuthority = expectDefined(
                          readOperatorToolGatewayAuthority()?.operatorRunAuthority,
                          "host-issued operator source",
                        );
                        const runId = "mcp-final-effect-" + transport + "-" + scenario;
                        const admission = prepareAgentRunAdmission({
                          cfg,
                          operatorAuthority,
                          operationalRunInstance: createOperationalRunInstanceRef(runId),
                          facts: {
                            runId,
                            agentId: "main",
                            ingress: {
                              kind: "system",
                              boundary: "mcp-final-effect-test",
                              state: "present",
                            },
                          },
                        });
                        const releaseWriter = createDeferredCore();
                        const atWriter = createDeferredCore();
                        let pending: Promise<object | null> | undefined;
                        let grantToken: string | undefined;
                        const realCall = inProcessGateway.callAgentToolGatewayRequest;
                        const requestSpy = vi
                          .spyOn(inProcessGateway, "callAgentToolGatewayRequest")
                          .mockImplementation(async (request) => {
                            if (request.method === "sessions.patch") {
                              atWriter.resolve();
                              await releaseWriter.promise;
                            }
                            return await realCall(request);
                          });
                        try {
                          const admittedRunContext = await admission.admit(
                            "gateway",
                            "mcp-final-effect-runtime",
                          );
                          const runtime = expectDefined(
                            getActiveMcpLoopbackRuntime(),
                            "MCP runtime",
                          );
                          const grant = mintMcpLoopbackClientGrant({
                            runtimeOwnerToken: runtime.ownerToken,
                            admittedRunContext,
                            context: {
                              sessionKey: requesterKey,
                              sessionId: "mcp-archive-requester-id",
                              agentId: "main",
                              runId,
                              senderIsOwner: false,
                              toolsAllow: ["sessions"],
                            },
                          });
                          grantToken = grant.token;
                          const captureKey = runId + "-capture";
                          expect(
                            activateMcpLoopbackClientGrantCapture({
                              token: grant.token,
                              runtimeOwnerToken: runtime.ownerToken,
                              captureKey,
                            }),
                          ).not.toBe(false);
                          const bound = expectDefined(
                            resolveMcpLoopbackClientGrant({
                              token: grant.token,
                              runtimeOwnerToken: runtime.ownerToken,
                              captureKey,
                            }),
                            "bound MCP source",
                          );
                          const args = {
                            action: "patch",
                            sessionKey: targetKey,
                            expectedSessionId: targetId,
                            archived: true,
                          };
                          if (transport === "HTTP") {
                            pending = (async () => {
                              const response = await fetch(
                                "http://127.0.0.1:" + runtime.port + "/mcp",
                                {
                                  method: "POST",
                                  headers: {
                                    authorization: "Bearer " + grant.token,
                                    "content-type": "application/json",
                                    "x-openclaw-cli-capture-key": captureKey,
                                  },
                                  body: JSON.stringify({
                                    jsonrpc: "2.0",
                                    id: 1,
                                    method: "tools/call",
                                    params: { name: "sessions", arguments: args },
                                  }),
                                },
                              );
                              const body = await response.text();
                              expect(response.status, body).toBe(200);
                              return JSON.parse(body);
                            })();
                          } else {
                            // Match the HTTP listener: only the bound run grants access,
                            // never the test caller invocation or ambient authenticated client.
                            pending = withPluginRuntimeGatewayRequestScope(scope, () =>
                              runOutsideOperatorToolGatewayAuthority(async () => {
                                const scoped = await new McpLoopbackToolCache().resolve({
                                  cfg,
                                  context: bound.context,
                                  sessionControlAuthority: operatorAuthority,
                                  grantToken: grant.token,
                                  isGrantCurrent: bound.isCurrent,
                                });
                                expect(scoped.toolSchema.map((tool) => tool.name)).toEqual([
                                  "sessions",
                                ]);
                                return await withGatewayToolCallerIdentity(
                                  createAdmittedGatewayToolCallerIdentity({
                                    admittedRunContext,
                                    receiptAuthority: bound.isCurrent,
                                    agentId: "main",
                                    sessionKey: requesterKey,
                                  }),
                                  () =>
                                    handleMcpJsonRpc({
                                      message: {
                                        jsonrpc: "2.0",
                                        id: 1,
                                        method: "tools/call",
                                        params: { name: "sessions", arguments: args },
                                      },
                                      tools: scoped.tools,
                                      toolSchema: scoped.toolSchema,
                                      authorizeToolCall: bound.isCurrent,
                                      hookContext: {
                                        config: cfg,
                                        agentId: "main",
                                        sessionKey: requesterKey,
                                        runId,
                                      },
                                    }),
                                );
                              }),
                            );
                          }
                          const reachedWriter = await Promise.race([
                            atWriter.promise.then(() => true),
                            pending.then(() => false),
                          ]);
                          expect(reachedWriter).toBe(scenario !== "assigned-noncreator");
                          if (scenario === "reassigned") {
                            assignSessionOwner(
                              { agentId: "main", sessionKey: targetKey },
                              {
                                owner: { type: "human", id: "different-person" },
                                assignedBy: { type: "human", id: profile.profileId },
                              },
                            );
                          } else if (scenario === "profile-revoked") {
                            setUserProfileRole(profile.profileId, "none");
                          } else if (scenario === "replaced") {
                            await replaceSessionEntry(
                              { agentId: "main", sessionKey: targetKey },
                              {
                                sessionId: "replacement-id",
                                updatedAt: 2,
                                visibility: "shared",
                                createdActor: {
                                  type: "human",
                                  source: "profile",
                                  id: profile.profileId,
                                },
                              },
                            );
                          }
                          releaseWriter.resolve();
                          const response = await pending;
                          const archiveAllowed =
                            scenario === "allowed" || scenario === "reassigned";
                          expect(response, JSON.stringify(response)).toMatchObject({
                            result: { isError: !archiveAllowed },
                          });
                          const entry = expectDefined(
                            loadSessionEntry({ agentId: "main", sessionKey: targetKey }),
                            "persisted target",
                          );
                          expect(entry.sessionId).toBe(
                            scenario === "replaced" ? "replacement-id" : targetId,
                          );
                          if (archiveAllowed) {
                            expect(entry.archivedAt).toEqual(expect.any(Number));
                          } else {
                            expect(entry.archivedAt).toBeUndefined();
                          }
                        } finally {
                          releaseWriter.resolve();
                          await pending?.catch(() => {});
                          requestSpy.mockRestore();
                          if (grantToken) {
                            revokeMcpLoopbackClientGrant(grantToken);
                          }
                          admission.close();
                        }
                      },
                    ),
                  );
                } finally {
                  await closeMcpLoopbackServer();
                }
              },
            ),
          );
        } finally {
          await resources.close();
        }
      });
    },
  );
}
