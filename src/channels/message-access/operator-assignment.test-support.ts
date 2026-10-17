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
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { unlinkUserChannelIdentity } from "../../state/user-channel-identities.js";
import { setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { withAdminIngress } from "./operator-authority.test-support.js";

type Fixture = Parameters<Parameters<typeof withAdminIngress>[0]>[0];
const humanSessionKey = "agent:main:dashboard:human-created";
const spawnedSessionKey = "agent:main:dashboard:agent-created";
const revokedMessage = "Channel operator authority changed; send a new request.";
const agent = { type: "agent", id: "main" } as const;
const human = (id: string) => ({ type: "human", id }) as const;
function autoClose<T extends { close: () => void }>(resource: T) {
  return { ...resource, [Symbol.dispose]: () => resource.close() };
}
export function withOperatorModels(
  authority: Parameters<typeof bindOperatorModelExecution>[0],
  revoke: () => void,
) {
  const models = Array.from({ length: 2 }, () => bindOperatorModelExecution(authority, undefined));
  try {
    for (const model of models) {
      expect(model?.signal.aborted).toBe(false);
    }
    revoke();
    for (const model of models) {
      expect(model?.signal).toMatchObject({ aborted: true, reason: { message: revokedMessage } });
      expect(model?.signal.reason).toBeInstanceOf(CommandOwnerRevokedError);
    }
  } finally {
    for (const model of models) {
      model?.release();
    }
  }
}

function prepareRun(cfg: Fixture["cfg"], turn: MsgContext, runId = "channel-assignment") {
  return autoClose(
    prepareChannelRunAdmission({
      cfg,
      runId,
      agentId: "main",
      ingressKind: "channel",
      boundary: turn.Provider!,
      assertSourceCurrent: captureCommandOwnerAssertion(turn),
      operatorAuthority: prepareInternalGetReplyOptions(undefined, turn)?.operatorAuthority,
    }),
  );
}

async function prepareAssignment(fixture: Fixture, turn: MsgContext, nativeAgent = false) {
  const { cfg, state, gateway, admins } = fixture;
  const sessionKey = turn.SessionKey!;
  const scope = (key: string) => ({ agentId: "main", sessionKey: key, env: state.env });
  await upsertSessionEntryCore(scope(sessionKey), {
    sessionId: "channel-requester",
    updatedAt: 1,
    visibility: "shared",
    createdActor: agent,
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
  const prepared = prepareRun(cfg, turn);
  const admitted = await prepared.admit("embedded");
  const operatorAuthority = readAdmittedRunOperatorAuthority(admitted);
  const { senderIsOwner } = resolveCommandAuthorization({
    cfg,
    ctx: turn,
    commandAuthorized: true,
  });
  const tools = (
    await resolveGatewayScopedTools({
      cfg,
      sessionKey,
      messageProvider: turn.Provider,
      senderIsOwner,
      surface: "loopback",
      admittedRunContext: admitted,
    })
  ).tools;
  const run = <T>(action: () => Promise<T>) =>
    withPluginRuntimeGatewayRequestScope(
      {
        context: gateway,
        // Plugin calls retain a profileless client; native tools use the admitted binding.
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
  const execute = (name: string, ...args: Parameters<(typeof tools)[number]["execute"]>) =>
    run(() => {
      const tool = tools.find((entry) => entry.name === name);
      expect(tool).toBeDefined();
      return tool!.execute(...args);
    });
  const assign = (target = humanSessionKey, profileId = admins[0]!.profile.id) =>
    execute("sessions", "assign-requester", {
      action: "assign_owner",
      sessionKey: target,
      ownerType: "human",
      ownerId: profileId,
    });
  return Object.assign(
    { prepared, operatorAuthority, tools, run, assign, scope, execute },
    {
      [Symbol.dispose]: () => prepared.close(),
    },
  );
}

export function registerOperatorAssignmentTests() {
  it.each([
    { channel: "slack", role: "admin" },
    { channel: "discord", role: "member" },
  ] as const)(
    "assigns visible and newly created sessions to the linked $channel $role",
    ({ channel, role }) =>
      withAdminIngress(
        async (fixture) => {
          setUserProfileRole(fixture.admins[0]!.profile.id, role);
          const turn = await fixture.context(fixture.admins[0]!.identity.senderId);
          const metadata = JSON.parse(
            buildInboundUserContextPrefix(turn).match(/```json\n([\s\S]*?)\n```/)![1]!,
          );
          using assignment = await prepareAssignment(fixture, turn, channel === "discord");
          const owner = human(fixture.admins[0]!.profile.id);
          const requester = human(metadata.requester_profile.id);
          const updated = { status: "updated", owner };
          if (role === "member") {
            expect(assignment.operatorAuthority).toBeUndefined();
            const tool = assignment.tools.find((entry) => entry.name === "sessions")!;
            expect(tool.parameters).toHaveProperty(
              "properties.action.enum",
              expect.arrayContaining(["assign_owner"]),
            );
            await expect(
              assignment.execute("sessions", "deny-settings", {
                action: "patch",
                label: "forbidden",
              }),
            ).rejects.toThrow("Only assign_owner");
          }
          // The router must authorize another visible session before the mutation handler runs.
          if (role === "admin") {
            expect(
              (await assignment.assign(humanSessionKey, metadata.requester_profile.id)).details,
            ).toMatchObject(updated);
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
                actor: agent,
                requesterSessionKey: turn.SessionKey,
                inheritedToolPolicy: { version: 1, allow: [], deny: [] },
              },
            ),
          );
          expect(loadSessionEntry(assignment.scope(spawnedSessionKey))).toMatchObject({
            createdVia: "spawn",
            createdActor: agent,
            owner: { actor: agent },
          });
          expect(
            (await assignment.assign(spawnedSessionKey, metadata.requester_profile.id)).details,
          ).toMatchObject(updated);
          const listed = await assignment.execute("sessions_list", "read-owner", {
            search: spawnedSessionKey,
          });
          expect(listed.details).toMatchObject({
            sessions: [
              {
                key: spawnedSessionKey,
                createdActor: agent,
                owner: { actor: requester },
              },
            ],
          });
          for (const key of role === "admin"
            ? [humanSessionKey, spawnedSessionKey]
            : [spawnedSessionKey]) {
            expect(loadSessionEntry(assignment.scope(key))?.owner?.actor).toEqual(requester);
          }
        },
        "role",
        channel,
      ),
  );

  it.each(["unlink", "role", "lifecycle", "gateway", "database", "stale-copy"] as const)(
    "rejects a retained Slack assignment after its %s authority changes",
    (change) =>
      withAdminIngress(
        async (fixture) => {
          const admin = fixture.admins[0]!;
          const original = await fixture.context(admin.identity.senderId);
          const turn = change === "stale-copy" ? { ...original } : original;
          using assignment = await prepareAssignment(fixture, turn);
          expect(assignment.operatorAuthority?.profileId).toBe(admin.profile.id);
          const changes = {
            unlink: () => unlinkUserChannelIdentity(admin.profile.id, admin.identity),
            role: () => setUserProfileRole(admin.profile.id, "member"),
            lifecycle: fixture.retire,
            "stale-copy": fixture.retire,
            gateway: fixture.replaceGatewayContext,
            database: () =>
              closeOpenClawStateDatabaseByPathAsync(
                resolveOpenClawStateSqlitePath(fixture.state.env),
              ),
          };
          await changes[change]();
          await expect(assignment.assign()).rejects.toThrow(revokedMessage);
          expect(loadSessionEntry(assignment.scope(humanSessionKey))?.owner).toBeUndefined();
        },
        "role",
        "slack",
      ),
  );

  it.each(["unlink", "role"] as const)(
    "cancels an active Slack model execution when its %s authority changes",
    (change) =>
      withAdminIngress(
        async ({ cfg, admins, context }) => {
          const admin = admins[0]!;
          const turn = await context(admin.identity.senderId);
          using prepared = prepareRun(cfg, turn, "slack-model-cancellation");
          const admitted = await prepared.admit("embedded");
          const authority = readAdmittedRunOperatorAuthority(admitted);
          withOperatorModels(authority, () => {
            if (change === "unlink") {
              unlinkUserChannelIdentity(admin.profile.id, admin.identity);
            } else {
              setUserProfileRole(admin.profile.id, "member");
            }
          });
        },
        "role",
        "slack",
      ),
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
        using assignment = await prepareAssignment(fixture, turn);
        expect(assignment.operatorAuthority).toBeUndefined();
        const tool = assignment.tools.find((entry) => entry.name === "sessions");
        expect(tool).toBeDefined();
        if (!configuredOwner) {
          expect(tool!.parameters).toHaveProperty(
            "properties.action.enum",
            expect.arrayContaining(["assign_owner"]),
          );
        }
        // An admitted agent may assign responsibility, but a bare RPC has no agent caller.
        await expect(
          assignment.run(() =>
            callInProcessGatewayTool("sessions.assignOwner", {
              key: humanSessionKey,
              owner: human(admin.profile.id),
            }),
          ),
        ).rejects.toThrow(/was not found/);
        expect(loadSessionEntry(assignment.scope(humanSessionKey))?.owner).toBeUndefined();
      },
      "role",
      "slack",
    );
  });
}
