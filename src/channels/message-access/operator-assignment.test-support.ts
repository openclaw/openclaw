import { expect, it } from "vitest";
import {
  bindOperatorModelExecution,
  readAdmittedRunOperatorAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  callInProcessGatewayTool,
  callInProcessGatewayToolWithCreation,
} from "../../agents/tools/in-process-gateway.js";
import { resolveCommandAuthorization } from "../../auto-reply/command-auth.js";
import {
  captureCommandOwnerAssertion,
  CommandOwnerRevokedError,
} from "../../auto-reply/command-owner-authority.js";
import { prepareChannelRunAdmission } from "../../auto-reply/reply/channel-run-admission.js";
import { prepareInternalGetReplyOptions } from "../../auto-reply/reply/get-reply.types.js";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createSessionMutationTestContext } from "../../gateway/server-methods/sessions-mutations.owner.test-support.js";
import { initializeSessionReadContext } from "../../gateway/server-methods/sessions-read-cache.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import { resolveGatewayScopedTools } from "../../gateway/tool-resolution.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { unlinkUserChannelIdentity } from "../../state/user-channel-identities.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { withAdminIngress } from "./operator-authority.test-support.js";

type Fixture = Parameters<Parameters<typeof withAdminIngress>[0]>[0];
const humanSessionKey = "agent:main:dashboard:human-created";
const spawnedSessionKey = "agent:main:dashboard:agent-created";
const revokedMessage = "Channel operator authority changed; send a new request.";

async function prepareAssignment(fixture: Fixture, turn: MsgContext, nativeAgent = false) {
  const { cfg, state, gateway, admins } = fixture;
  const sessionKey = turn.SessionKey!;
  const scope = (key: string) => ({ agentId: "main", sessionKey: key, env: state.env });
  await upsertSessionEntryCore(scope(sessionKey), {
    sessionId: "channel-requester",
    updatedAt: 1,
    visibility: "shared",
    createdActor: { type: "agent", id: "main" },
  });
  await upsertSessionEntryCore(scope(humanSessionKey), {
    sessionId: "human-created",
    updatedAt: 1,
    visibility: "shared",
    createdVia: "operator",
    createdActor: { type: "human", source: "profile", id: admins[1]!.profile.id },
  });
  Object.assign(gateway, createSessionMutationTestContext(cfg));
  gateway.resolveGatewayContext = () => gateway;
  gateway.loadGatewayModelCatalogSnapshot = async () => ({
    agentId: "main",
    agentDir: state.agentDir("main"),
    workspaceDir: state.workspaceDir,
    config: cfg,
    catalogComplete: true,
    entries: [],
    routeVariants: [],
  });
  await initializeSessionReadContext(gateway);
  const prepared = prepareChannelRunAdmission({
    cfg,
    runId: "channel-assignment",
    agentId: "main",
    ingressKind: "channel",
    boundary: turn.Provider!,
    assertSourceCurrent: captureCommandOwnerAssertion(turn),
    operatorAuthority: prepareInternalGetReplyOptions(undefined, turn)?.operatorAuthority,
  });
  const admitted = await prepared.admit("embedded");
  const operatorAuthority = readAdmittedRunOperatorAuthority(admitted);
  const { senderIsOwner } = resolveCommandAuthorization({
    cfg,
    ctx: turn,
    commandAuthorized: true,
  });
  const tools = resolveGatewayScopedTools({
    cfg,
    sessionKey,
    messageProvider: turn.Provider,
    senderIsOwner,
    surface: "loopback",
    admittedRunContext: admitted,
  }).tools;
  const run = <T>(action: () => Promise<T>) =>
    withPluginRuntimeGatewayRequestScope(
      {
        context: gateway,
        // Native agent tools use their admitted Gateway binding. Plugin invocations
        // retain the separate profileless client and its narrower permissions.
        client: nativeAgent ? null : createSyntheticPluginRuntimeClient(),
        isWebchatConnect: () => false,
      },
      () =>
        withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey,
            gatewayContextResolver: () => gateway,
            operationalRunInstance: admitted.operationalRunInstance,
            operatorAuthority,
            receiptAuthority: resolveAdmittedRunActiveAssertion(admitted),
          },
          action,
        ),
    );
  const assign = (target = humanSessionKey, profileId = admins[0]!.profile.id) =>
    run(async () => {
      const tool = tools.find((entry) => entry.name === "sessions");
      expect(tool).toBeDefined();
      return await tool!.execute("assign-requester", {
        action: "assign_owner",
        sessionKey: target,
        ownerType: "human",
        ownerId: profileId,
      });
    });
  return { prepared, operatorAuthority, tools, run, assign, scope };
}

export function registerOperatorAssignmentTests() {
  it.each([
    { channel: "slack", role: "admin" },
    { channel: "discord", role: "member" },
  ] as const)(
    "assigns visible and newly created sessions to the linked $channel $role",
    async ({ channel, role }) => {
      await withAdminIngress(
        async (fixture) => {
          setUserProfileRole(fixture.admins[0]!.profile.id, role);
          const turn = await fixture.context(fixture.admins[0]!.identity.senderId);
          const metadata = JSON.parse(
            buildInboundUserContextPrefix(turn).match(/```json\n([\s\S]*?)\n```/)![1]!,
          );
          const assignment = await prepareAssignment(fixture, turn, channel === "discord");
          try {
            if (role === "member") {
              expect(assignment.operatorAuthority).toBeUndefined();
              const tool = assignment.tools.find((entry) => entry.name === "sessions")!;
              expect(tool.parameters).toHaveProperty("properties.action.enum", ["assign_owner"]);
              await expect(
                assignment.run(() =>
                  tool.execute("deny-settings", { action: "patch", label: "forbidden" }),
                ),
              ).rejects.toThrow("Only assign_owner");
            }
            // The router must authorize another visible session before the mutation handler runs.
            if (role === "admin") {
              expect(
                (await assignment.assign(humanSessionKey, metadata.requester_profile.id)).details,
              ).toMatchObject({
                status: "updated",
                owner: { type: "human", id: fixture.admins[0]!.profile.id },
              });
            }
            await assignment.run(() =>
              callInProcessGatewayToolWithCreation(
                "sessions.create",
                {
                  key: spawnedSessionKey,
                  agentId: "main",
                  visibility: "shared",
                  parentSessionKey: turn.SessionKey,
                  spawnDepth: 1,
                },
                {
                  via: "spawn",
                  actor: { type: "agent", id: "main" },
                  requesterSessionKey: turn.SessionKey,
                  inheritedToolPolicy: { version: 1, allow: [], deny: [] },
                },
              ),
            );
            expect(loadSessionEntry(assignment.scope(spawnedSessionKey))).toMatchObject({
              createdVia: "spawn",
              createdActor: { type: "agent", id: "main" },
              owner: { actor: { type: "agent", id: "main" } },
            });
            expect(
              (await assignment.assign(spawnedSessionKey, metadata.requester_profile.id)).details,
            ).toMatchObject({
              status: "updated",
              owner: { type: "human", id: fixture.admins[0]!.profile.id },
            });
            const listed = await assignment.run(async () => {
              const tool = assignment.tools.find((entry) => entry.name === "sessions_list")!;
              expect(tool).toBeDefined();
              return await tool.execute("read-owner", { search: spawnedSessionKey });
            });
            expect(listed.details).toMatchObject({
              sessions: [
                {
                  key: spawnedSessionKey,
                  createdActor: { type: "agent", id: "main" },
                  owner: { actor: { type: "human", id: metadata.requester_profile.id } },
                },
              ],
            });
            for (const key of role === "admin"
              ? [humanSessionKey, spawnedSessionKey]
              : [spawnedSessionKey]) {
              expect(loadSessionEntry(assignment.scope(key))?.owner?.actor).toEqual({
                type: "human",
                id: metadata.requester_profile.id,
              });
            }
          } finally {
            await assignment.prepared.close();
          }
        },
        "role",
        channel,
      );
    },
  );

  it.each(["unlink", "role", "lifecycle", "gateway", "database", "stale-copy"] as const)(
    "rejects a retained Slack assignment after its %s authority changes",
    async (change) => {
      await withAdminIngress(
        async (fixture) => {
          const admin = fixture.admins[0]!;
          const original = await fixture.context(admin.identity.senderId);
          const turn = change === "stale-copy" ? { ...original } : original;
          const assignment = await prepareAssignment(fixture, turn);
          try {
            expect(assignment.operatorAuthority?.profileId).toBe(admin.profile.id);
            if (change === "unlink") {
              unlinkUserChannelIdentity(admin.profile.id, admin.identity);
            } else if (change === "role") {
              setUserProfileRole(admin.profile.id, "member");
            } else if (change === "lifecycle" || change === "stale-copy") {
              fixture.retire();
            } else if (change === "gateway") {
              fixture.replaceGatewayContext();
            } else if (change === "database") {
              await closeOpenClawStateDatabaseAsync();
            }
            await expect(assignment.assign()).rejects.toThrow(revokedMessage);
            expect(loadSessionEntry(assignment.scope(humanSessionKey))?.owner).toBeUndefined();
          } finally {
            await assignment.prepared.close();
          }
        },
        "role",
        "slack",
      );
    },
  );

  it.each(["unlink", "role"] as const)(
    "cancels an active Slack model execution when its %s authority changes",
    async (change) => {
      await withAdminIngress(
        async ({ cfg, admins, context }) => {
          const admin = admins[0]!;
          const turn = await context(admin.identity.senderId);
          const prepared = prepareChannelRunAdmission({
            cfg,
            runId: "slack-model-cancellation",
            agentId: "main",
            ingressKind: "channel",
            boundary: "slack",
            assertSourceCurrent: captureCommandOwnerAssertion(turn),
            operatorAuthority: prepareInternalGetReplyOptions(undefined, turn)?.operatorAuthority,
          });
          const admitted = await prepared.admit("embedded");
          const authority = readAdmittedRunOperatorAuthority(admitted);
          const models = [
            bindOperatorModelExecution(authority, undefined),
            bindOperatorModelExecution(authority, undefined),
          ];
          try {
            for (const model of models) {
              expect(model?.signal.aborted).toBe(false);
            }
            if (change === "unlink") {
              unlinkUserChannelIdentity(admin.profile.id, admin.identity);
            } else {
              setUserProfileRole(admin.profile.id, "member");
            }
            for (const model of models) {
              expect(model?.signal.aborted).toBe(true);
              expect(model?.signal.reason).toBeInstanceOf(CommandOwnerRevokedError);
              expect(model?.signal.reason).toMatchObject({ message: revokedMessage });
            }
          } finally {
            for (const model of models) {
              model?.release();
            }
            await prepared.close();
          }
        },
        "role",
        "slack",
      );
    },
  );

  it.each([
    "asserted",
    "unlinked",
    "member",
    "cloned",
    "configured-owner",
    "configured-owner-linked",
  ] as const)("does not give a %s Slack sender an operator principal", async (kind) => {
    await withAdminIngress(
      async (fixture) => {
        const admin = fixture.admins[0]!;
        if (kind === "member") {
          setUserProfileRole(admin.profile.id, "member");
        }
        const configuredOwner = kind === "configured-owner" || kind === "configured-owner-linked";
        if (configuredOwner) {
          fixture.cfg.commands!.ownerAllowFrom = [`slack:${admin.identity.senderId}`];
          if (kind === "configured-owner") {
            unlinkUserChannelIdentity(admin.profile.id, admin.identity);
          }
        }
        const original = await fixture.context(
          kind === "unlinked" ? "unlinked" : admin.identity.senderId,
          kind !== "asserted",
        );
        const turn = kind === "cloned" ? structuredClone(original) : original;
        const assignment = await prepareAssignment(fixture, turn);
        try {
          expect(assignment.operatorAuthority).toBeUndefined();
          const tool = assignment.tools.find((entry) => entry.name === "sessions");
          expect(tool).toBeDefined();
          if (!configuredOwner) {
            expect(tool!.parameters).toHaveProperty("properties.action.enum", ["assign_owner"]);
          }
          // An admitted agent may assign responsibility, but a bare RPC has no agent caller.
          await expect(
            assignment.run(() =>
              callInProcessGatewayTool("sessions.assignOwner", {
                key: humanSessionKey,
                owner: { type: "human", id: admin.profile.id },
              }),
            ),
          ).rejects.toThrow(/was not found/);
          expect(loadSessionEntry(assignment.scope(humanSessionKey))?.owner).toBeUndefined();
        } finally {
          await assignment.prepared.close();
        }
      },
      "role",
      "slack",
    );
  });
}
