import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { readAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { resolveBootstrapContextForRun } from "../agents/bootstrap-files.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { callInProcessGatewayToolWithCreation } from "../agents/tools/in-process-gateway.js";
import { createPersonalInstructionsTool } from "../agents/tools/personal-instructions-tool.js";
import { resolveCommandAuthorization } from "../auto-reply/command-auth.js";
import { prepareChannelRunAdmission } from "../auto-reply/reply/channel-run-admission.js";
import { buildInboundUserContextPrefix } from "../auto-reply/reply/inbound-meta.js";
import { getRequesterProfile } from "../auto-reply/requester-profile.js";
import { installDiscordRegistryHooks } from "../auto-reply/test-helpers/command-auth-registry-fixture.js";
import {
  readChannelContextAdmissionEvidence,
  readChannelContextGatewayContextResolver,
} from "../channels/message-access/admission-evidence.js";
import { withAdminIngress } from "../channels/message-access/operator-authority.test-support.js";
import type { CliDeps } from "../cli/deps.types.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { sessionPersonalProfileId } from "../config/sessions/session-entry-provenance.js";
import {
  bindGatewayContextResolver,
  getPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { isSessionPersonalBootstrapTurn } from "../sessions/session-participant-input.js";
import { setUserProfileRole } from "../state/user-profiles.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintAttachGrant,
  mintMcpLoopbackClientGrant,
  revokeAttachGrant,
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import { getActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";

installDiscordRegistryHooks();

it("assigns and reads back a created session through admitted non-owner Discord MCP", async () => {
  await withAdminIngress(async (fixture) => {
    const { cfg, state } = fixture;
    const sessionKey = "agent:main:discord:channel:maintainers";
    const targetKey = "agent:main:dashboard:assignment";
    cfg.agents = { entries: { main: { workspace: state.workspaceDir } } };
    cfg.plugins = { enabled: false };
    cfg.tools = { allow: ["sessions", "sessions_list"] };
    await state.writeConfig(cfg);
    const scope = { agentId: "main", sessionKey: targetKey };
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "assignment-session",
        updatedAt: 1,
        createdActor: { type: "agent", id: "main" },
        visibility: "shared",
      },
    );
    const profile = fixture.admins[0]!.profile;
    setUserProfileRole(profile.id, "member");
    await withLocalGatewayRequestScope(
      { deps: {} as CliDeps, getRuntimeConfig: () => cfg },
      async () => {
        await ensureMcpLoopbackServer();
        const runtime = getActiveMcpLoopbackRuntime();
        const gateway = getPluginRuntimeGatewayRequestScope()?.context;
        if (!runtime || !gateway) {
          throw new Error("missing isolated MCP/Gateway fixture");
        }
        fixture.replaceGatewayContext(gateway);
        const turn = await fixture.context(fixture.admins[0]!.identity.senderId);
        expect(turn.SessionKey).toBe(sessionKey);
        const metadata = JSON.parse(
          buildInboundUserContextPrefix(turn).match(/```json\n([\s\S]*?)\n```/)![1]!,
        );
        expect(metadata.requester_profile.id).toBe(profile.id);
        const { senderIsOwner } = resolveCommandAuthorization({
          cfg,
          ctx: turn,
          commandAuthorized: true,
        });
        expect(senderIsOwner).toBe(false);
        const prepareTurn = (source: typeof turn, runId: string) =>
          prepareChannelRunAdmission({
            cfg,
            runId,
            agentId: "main",
            ingressKind: "channel",
            boundary: "auto-reply.agent-runner",
            evidence: readChannelContextAdmissionEvidence(source),
            onAdmitted: (context) =>
              bindGatewayContextResolver(context, readChannelContextGatewayContextResolver(source)),
          });
        const admission = prepareTurn(turn, "assignment-run");
        const admittedRunContext = await admission.admit("gateway", "assignment-execution");
        expect(readAdmittedRunOperatorAuthority(admittedRunContext)).toBeUndefined();
        await withGatewayToolCallerIdentity(
          createAdmittedGatewayToolCallerIdentity({
            admittedRunContext,
            agentId: "main",
            sessionKey,
          }),
          () =>
            callInProcessGatewayToolWithCreation(
              "sessions.create",
              {
                key: targetKey,
                agentId: "main",
                parentSessionKey: sessionKey,
                spawnDepth: 1,
                visibility: "shared",
              },
              {
                via: "spawn",
                actor: { type: "agent", id: "main" },
                requesterSessionKey: sessionKey,
                inheritedToolPolicy: { version: 1, allow: ["sessions", "sessions_list"], deny: [] },
              },
            ),
        );
        expect(loadSessionEntry(scope)).toMatchObject({
          createdActor: { type: "agent", id: "main" },
          owner: { actor: { type: "agent", id: "main" } },
        });
        const grant = mintMcpLoopbackClientGrant({
          context: {
            sessionKey,
            senderIsOwner,
            messageProvider: "discord",
            accountId: turn.AccountId,
            currentChannelId: turn.OriginatingTo,
            runId: "assignment-run",
            toolsAllow: ["sessions", "sessions_list"],
          },
          runtimeOwnerToken: runtime.ownerToken,
          admittedRunContext,
        });
        const capture = activateMcpLoopbackClientGrantCapture({
          token: grant.token,
          runtimeOwnerToken: runtime.ownerToken,
          captureKey: "assignment-capture",
        });
        expect(capture).toBeDefined();
        const attach = mintAttachGrant({ sessionKey, agentId: "main" });
        const request = async (
          token: string,
          attached: boolean,
          method: "tools/list" | "tools/call",
          ownerId = metadata.requester_profile.id,
          toolName = "sessions",
          targetSessionKey = targetKey,
        ) => {
          const response = await fetch("http://127.0.0.1:" + runtime.port + "/mcp", {
            method: "POST",
            headers: {
              authorization: "Bearer " + token,
              "content-type": "application/json",
              ...(attached ? {} : { "x-openclaw-cli-capture-key": "assignment-capture" }),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method,
              ...(method === "tools/call"
                ? {
                    params: {
                      name: toolName,
                      arguments:
                        toolName === "sessions_list"
                          ? { search: targetKey }
                          : {
                              action: "assign_owner",
                              sessionKey: targetSessionKey,
                              ownerType: "human",
                              ownerId,
                            },
                    },
                  }
                : {}),
            }),
          });
          expect(response.status).toBe(200);
          const payload = await response.json();
          return payload as {
            result?: {
              tools?: Array<{ name: string }>;
              isError?: boolean;
              content?: Array<{ type: string; text?: string }>;
            };
            error?: unknown;
          };
        };
        try {
          expect(
            (await request(grant.token, false, "tools/list")).result?.tools?.some(
              (tool) => tool.name === "sessions",
            ),
          ).toBe(true);
          expect(await request(grant.token, false, "tools/call")).toMatchObject({
            result: { isError: false },
          });
          expect(loadSessionEntry(scope)).toMatchObject({
            owner: {
              actor: { type: "human", id: profile.id },
              assignedBy: { type: "agent", id: "main" },
            },
            createdActor: { type: "agent", id: "main" },
            visibility: "shared",
          });
          const listed = await request(
            grant.token,
            false,
            "tools/call",
            profile.id,
            "sessions_list",
          );
          expect(listed).toMatchObject({ result: { isError: false } });
          expect(JSON.parse(listed.result?.content?.[0]?.text ?? "")).toMatchObject({
            sessions: [
              {
                key: targetKey,
                createdActor: { type: "agent", id: "main" },
                owner: { actor: { type: "human", id: profile.id } },
              },
            ],
          });
          const next = fixture.admins[1]!.profile;
          expect(next.id).not.toBe(profile.id);
          const personalDir = path.join(state.workspaceDir, "users", next.id);
          await fs.mkdir(personalDir, { recursive: true });
          await fs.writeFile(path.join(state.workspaceDir, "USER.md"), "Shared preferences.");
          await fs.writeFile(path.join(personalDir, "USER.md"), "Assignee preferences.");
          expect(
            await request(grant.token, false, "tools/call", next.id, "sessions", sessionKey),
          ).toMatchObject({ result: { isError: false } });
          const assigned = loadSessionEntry({ agentId: "main", sessionKey });
          expect(assigned).toMatchObject({
            owner: { actor: { type: "human", id: next.id } },
            createdActor: { type: "agent", id: "main" },
            visibility: "shared",
          });

          const nextTurn = await fixture.context(fixture.admins[0]!.identity.senderId);
          expect(nextTurn.SessionKey).toBe(sessionKey);
          expect(isSessionPersonalBootstrapTurn(nextTurn)).toBe(true);
          expect(getRequesterProfile(nextTurn)?.id).toBe(profile.id);
          expect(
            resolveCommandAuthorization({ cfg, ctx: nextTurn, commandAuthorized: true })
              .senderIsOwner,
          ).toBe(false);
          const nextAdmission = prepareTurn(nextTurn, "assignment-followup");
          try {
            const nextContext = await nextAdmission.admit(
              "gateway",
              "assignment-followup-execution",
            );
            expect(readAdmittedRunOperatorAuthority(nextContext)).toBeUndefined();
            // Match the external-turn selection before exercising the real bootstrap owner.
            const bootstrap = await resolveBootstrapContextForRun({
              workspaceDir: state.workspaceDir,
              config: cfg,
              sessionKey,
              bootstrapUserProfileId: sessionPersonalProfileId(assigned),
            });
            expect(
              bootstrap.contextFiles
                .filter((file) => file.path.endsWith("USER.md"))
                .map((file) => file.content),
            ).toEqual(["Shared preferences.", "Assignee preferences."]);
            await expect(
              withGatewayToolCallerIdentity(
                createAdmittedGatewayToolCallerIdentity({
                  admittedRunContext: nextContext,
                  agentId: "main",
                  sessionKey,
                }),
                () =>
                  createPersonalInstructionsTool("main").execute("no-borrowed-profile", {
                    action: "get",
                  }),
              ),
            ).rejects.toThrow(
              "Personal instructions require a live authenticated Gateway user turn",
            );
          } finally {
            nextAdmission.close();
          }
          const before = loadSessionEntry(scope)?.owner;
          const denied = await request(attach.token, true, "tools/call", next.id);
          expect(denied).toMatchObject({
            result: {
              isError: true,
              content: [{ type: "text", text: "Tool not available: sessions" }],
            },
          });
          expect.soft(loadSessionEntry(scope)?.owner).toEqual(before);
          expect
            .soft(
              (await request(attach.token, true, "tools/list")).result?.tools?.some(
                (tool) => tool.name === "sessions",
              ),
            )
            .toBe(false);
          let revoke = true;
          gateway.getRuntimeConfig = () => {
            if (revoke) {
              revoke = false;
              revokeMcpLoopbackClientGrant(grant.token);
            }
            return cfg;
          };
          const retired = await request(grant.token, false, "tools/call", next.id);
          expect(retired).toMatchObject({
            result: {
              isError: true,
              content: [
                { type: "text", text: expect.stringMatching(/authority.*no longer active/i) },
              ],
            },
          });
          expect(loadSessionEntry(scope)?.owner).toEqual(before);
        } finally {
          revokeAttachGrant(attach.token);
          revokeMcpLoopbackClientGrant(grant.token);
          admission.close();
          await closeMcpLoopbackServer();
        }
      },
    );
  });
});
