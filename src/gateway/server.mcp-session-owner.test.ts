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
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { withLocalGatewayRequestScope } from "./local-request-context.js";
import {
  activateMcpLoopbackClientGrantCapture,
  mintAttachGrant,
  mintMcpLoopbackClientGrant,
  revokeAttachGrant,
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { closeMcpLoopbackServer } from "./mcp-http.js";
import * as mcp from "./mcp-http.test-support.js";

installDiscordRegistryHooks();

it("assigns and reads back a created session through admitted non-owner Discord MCP", async () => {
  await withAdminIngress(async (fixture) => {
    const { cfg, state } = fixture;
    const sessionKey = "agent:main:discord:channel:maintainers";
    const targetKey = "agent:main:dashboard:assignment";
    const agentId = "main";
    const actor = { type: "agent", id: agentId } as const;
    const toolsAllow = ["sessions", "sessions_list"];
    const readSession = (key = targetKey) => loadSessionEntry({ agentId, sessionKey: key });
    const expectOwner = (id: string, key = targetKey, assigned = false) =>
      expect(readSession(key)).toMatchObject({
        owner: { actor: { type: "human", id }, ...(assigned ? { assignedBy: actor } : {}) },
        createdActor: actor,
        visibility: "shared",
      });
    const expectToolError = (response: unknown, text: unknown) =>
      expect(response).toMatchObject({
        result: { isError: true, content: [{ type: "text", text }] },
      });
    cfg.agents = { entries: { main: { workspace: state.workspaceDir } } };
    cfg.plugins = { enabled: false };
    cfg.tools = { allow: toolsAllow };
    await state.writeConfig(cfg);
    await upsertSessionEntryCore(
      { agentId, sessionKey },
      {
        sessionId: "assignment-session",
        updatedAt: 1,
        createdActor: actor,
        visibility: "shared",
      },
    );
    const profile = fixture.admins[0]!.profile;
    setUserProfileRole(profile.id, "member");
    const run = async () => {
      const { runtime } = await mcp.startLoopbackServerForTest();
      const gateway = getPluginRuntimeGatewayRequestScope()?.context;
      if (!gateway) {
        throw new Error("missing isolated MCP/Gateway fixture");
      }
      fixture.replaceGatewayContext(gateway);
      const turn = await fixture.context(fixture.admins[0]!.identity.senderId);
      expect(turn.SessionKey).toBe(sessionKey);
      const metadata = JSON.parse(
        buildInboundUserContextPrefix(turn).match(/```json\n([\s\S]*?)\n```/)![1]!,
      );
      expect(metadata.requester_profile.id).toBe(profile.id);
      const isOwner = (ctx: typeof turn) =>
        resolveCommandAuthorization({ cfg, ctx, commandAuthorized: true }).senderIsOwner;
      const senderIsOwner = isOwner(turn);
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
      const withCaller = <T>(context: typeof admittedRunContext, invoke: () => T) =>
        withGatewayToolCallerIdentity(
          createAdmittedGatewayToolCallerIdentity({
            admittedRunContext: context,
            agentId,
            sessionKey,
          }),
          invoke,
        );
      await withCaller(admittedRunContext, () =>
        callInProcessGatewayToolWithCreation(
          "sessions.create",
          {
            key: targetKey,
            agentId,
            parentSessionKey: sessionKey,
            spawnDepth: 1,
            visibility: "shared",
          },
          {
            via: "spawn",
            actor,
            requesterSessionKey: sessionKey,
            inheritedToolPolicy: { version: 1, allow: toolsAllow, deny: [] },
          },
        ),
      );
      expect(readSession()).toMatchObject({ createdActor: actor, owner: { actor } });
      const grant = mintMcpLoopbackClientGrant({
        context: {
          sessionKey,
          senderIsOwner,
          messageProvider: "discord",
          accountId: turn.AccountId,
          currentChannelId: turn.OriginatingTo,
          runId: "assignment-run",
          toolsAllow,
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
        params?: { name: string; arguments: Record<string, unknown> },
      ) => {
        const response = await mcp.sendRaw({
          port: runtime.port,
          token,
          headers: {
            "content-type": "application/json",
            ...(attached ? {} : { "x-openclaw-cli-capture-key": "assignment-capture" }),
          },
          body: params
            ? mcp.mcpToolCallBody(params.name, params.arguments)
            : JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        return mcp.readOkMcpPayload(response);
      };
      const assignment = (ownerId = profile.id, key = targetKey) => ({
        name: "sessions",
        arguments: { action: "assign_owner", sessionKey: key, ownerType: "human", ownerId },
      });
      const call = (ownerId = profile.id, key = targetKey) =>
        request(grant.token, false, assignment(ownerId, key));
      const listsSessions = async (token: string, attached: boolean) =>
        (await request(token, attached)).result?.tools?.some((tool) => tool.name === "sessions");
      try {
        expect(await listsSessions(grant.token, false)).toBe(true);
        expect(await call()).toMatchObject({ result: { isError: false } });
        expectOwner(profile.id, targetKey, true);
        const listed = await request(grant.token, false, {
          name: "sessions_list",
          arguments: { search: targetKey },
        });
        expect(listed).toMatchObject({ result: { isError: false } });
        const listedText = listed.result?.content?.[0]?.text;
        if (typeof listedText !== "string") {
          throw new Error("expected sessions_list text response");
        }
        expect(JSON.parse(listedText)).toMatchObject({
          sessions: [
            {
              key: targetKey,
              createdActor: actor,
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
        expect(await call(next.id, sessionKey)).toMatchObject({
          result: { isError: false },
        });
        const assigned = readSession(sessionKey);
        expectOwner(next.id, sessionKey);

        const nextTurn = await fixture.context(fixture.admins[0]!.identity.senderId);
        expect(nextTurn.SessionKey).toBe(sessionKey);
        expect(isSessionPersonalBootstrapTurn(nextTurn)).toBe(true);
        expect(getRequesterProfile(nextTurn)?.id).toBe(profile.id);
        expect(isOwner(nextTurn)).toBe(false);
        const nextAdmission = prepareTurn(nextTurn, "assignment-followup");
        try {
          const nextContext = await nextAdmission.admit("gateway", "assignment-followup-execution");
          expect(readAdmittedRunOperatorAuthority(nextContext)).toBeUndefined();
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
            withCaller(nextContext, () =>
              createPersonalInstructionsTool("main").execute("no-borrowed-profile", {
                action: "get",
              }),
            ),
          ).rejects.toThrow("Personal instructions require a live authenticated Gateway user turn");
        } finally {
          nextAdmission.close();
        }
        const before = readSession()?.owner;
        expectToolError(
          await request(attach.token, true, assignment(next.id)),
          "Tool not available: sessions",
        );
        expect.soft(readSession()?.owner).toEqual(before);
        expect.soft(await listsSessions(attach.token, true)).toBe(false);
        let revoke = true;
        gateway.getRuntimeConfig = () => {
          if (revoke) {
            revoke = false;
            revokeMcpLoopbackClientGrant(grant.token);
          }
          return cfg;
        };
        expectToolError(await call(next.id), expect.stringMatching(/authority.*no longer active/i));
        expect(readSession()?.owner).toEqual(before);
      } finally {
        revokeAttachGrant(attach.token);
        revokeMcpLoopbackClientGrant(grant.token);
        admission.close();
        await closeMcpLoopbackServer();
      }
    };
    await withLocalGatewayRequestScope({ deps: {} as CliDeps, getRuntimeConfig: () => cfg }, run);
  });
});
