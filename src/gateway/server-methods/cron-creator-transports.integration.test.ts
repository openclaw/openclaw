import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withTestTimeout,
} from "../../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import {
  bindCronRequesterGrant,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { createAgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../device-revocation.js";
import {
  deactivateMcpLoopbackClientGrantCapture,
  revokeMcpLoopbackClientGrant,
} from "../mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../mcp-http.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import { resolveGatewayChatCronCreatorAuthorityAdmission } from "./cron-creator-authority-admission.js";
import { cronHandlers } from "./cron.js";
import {
  SESSION,
  CREATOR,
  cfg,
  stateDir,
  admission,
  inRun,
  createCronFixture,
  type CreatorTransportTools,
  createCreatorTransportTools,
  installRequesterCronAuthorityTestHooks,
} from "./requester-cron-authority.test-support.js";
import type { GatewayClient, RespondFn } from "./types.js";

// Attached-node inventory is unrelated to these original-caller and Cron commit boundaries.
vi.mock("../../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

installRequesterCronAuthorityTestHooks();

describe("original caller through Cron creator transports", () => {
  it(
    "commits a tool-free remote admin request but rejects revoked and out-of-scope writes",
    { timeout: 30_000 },
    async () => {
      const config: OpenClawConfig = { ...cfg };
      setRuntimeConfigSnapshot(config);
      const entered = createDeferred();
      const release = createDeferred();
      let hold = false;
      const fixture = createCronFixture(async () => {
        if (hold) {
          entered.resolve();
          await release.promise;
        }
        return [];
      }, config);
      const caller = captureGatewayDeviceRevocation(
        fixture.context,
        { deviceId: "requester-device", role: "operator" },
        () => true,
      );
      const admin = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
      admin.internal = { controlUiAdmin: true };
      const runId = "remote-admin-requester-write";
      const admitted = expectDefined(
        admission(runId, admin, undefined, caller.isCurrent),
        "remote admin admission",
      );
      expect(admitted.callerScopedCreation).toBe(true);

      const job = {
        schedule: { kind: "every" as const, everyMs: 60_000 },
        sessionTarget: "current" as const,
        payload: { kind: "agentTurn" as const, message: "Check status", toolsAllow: [] },
        delivery: { mode: "none" as const },
      };
      const invoke = async (client: GatewayClient, name: string, agentId?: string) => {
        const params = { ...job, name, ...(agentId ? { agentId } : {}) };
        const respond = vi.fn<RespondFn>();
        await expectDefined(
          cronHandlers["cron.add"],
          "cron.add handler",
        )({
          req: { type: "req", id: name, method: "cron.add", params },
          params,
          client,
          context: fixture.context,
          respond,
          isWebchatConnect: () => false,
        });
        return expectDefined(respond.mock.calls[0], "cron.add response");
      };

      try {
        await inRun(runId, admitted, async (identity, run) => {
          bindGatewayContextResolver(run, () => fixture.context);
          try {
            const issue = expectDefined(bindCronRequesterGrant(runId), "requester grant");
            const runtimeIdentity = expectDefined(
              await createAgentRuntimeIdentity({
                agentId: identity.agentId,
                sessionKey: identity.sessionKey,
                operationalRunInstance: identity.operationalRunInstance,
                cronCreatorAuthorityGrant: issue(),
              }),
              "remote requester runtime identity",
            );
            expect(runtimeIdentity.cronToolsAllowCapture).toBeUndefined();
            const agentClient = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
            agentClient.internal!.agentRuntimeIdentity = runtimeIdentity;

            const allowed = await invoke(agentClient, "Allowed requester");
            expect(allowed[0], JSON.stringify(allowed)).toBe(true);
            const stored = await fixture.read();
            expect(stored).toMatchObject([
              { name: "Allowed requester", payload: { toolsAllow: [] } },
            ]);
            expect(stored[0]?.runtimeAuthority).toBeUndefined();

            agentClient.internal!.agentRuntimeIdentity = await createAgentRuntimeIdentity({
              agentId: identity.agentId,
              sessionKey: identity.sessionKey,
              operationalRunInstance: identity.operationalRunInstance,
              cronCreatorAuthorityGrant: issue(),
            });
            hold = true;
            const pending = invoke(agentClient, "Revoked requester");
            try {
              await awaitGateBeforeSettlement(
                entered.promise,
                pending,
                "cron validation was not reached",
              );
              invalidateGatewayDeviceRevocation(fixture.context, "requester-device", "operator");
            } finally {
              release.resolve();
            }
            const denied = await pending;
            expect(denied[0]).toBe(false);
            expect(denied[2]?.message).toMatch(/authority.*no longer active/i);
            expect(await fixture.read()).toEqual(stored);
          } finally {
            release.resolve();
            clearGatewayContextResolver(run);
          }
        });

        const nonadmin = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
        nonadmin.internal = { controlUiAdmin: true };
        expect(admission("nonadmin-requester", nonadmin)).toBeUndefined();
        await inRun("nonadmin-requester", undefined, async (identity) => {
          nonadmin.internal!.agentRuntimeIdentity = identity;
          const respond = vi.fn<RespondFn>();
          await handleGatewayRequest({
            req: {
              type: "req",
              id: "nonadmin-rpc",
              method: "cron.add",
              params: { ...job, name: "Nonadmin RPC" },
            },
            client: nonadmin,
            context: fixture.context,
            respond,
            isWebchatConnect: () => false,
          });
          expect(respond.mock.calls[0]).toMatchObject([
            false,
            undefined,
            { message: "missing scope: operator.admin" },
          ]);
          expect((await fixture.read()).map((entry) => entry.name)).toEqual(["Allowed requester"]);

          const denied = await invoke(nonadmin, "Out-of-scope requester", "other-agent");
          expect(denied[0]).toBe(false);
          expect(denied[2]?.message).toContain("outside caller scope");
          expect((await fixture.read()).map((entry) => entry.name)).toEqual(["Allowed requester"]);
        });
      } finally {
        release.resolve();
        caller.release();
      }
    },
  );

  it("preserves ordinary restricted caller creation without management admission", async () => {
    const config: OpenClawConfig = { ...cfg, tools: { allow: [AUTOMATIONS_TOOL_NAME] } };
    setRuntimeConfigSnapshot(config);
    const fixture = createCronFixture(undefined, config);
    const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
    client.internal = {};
    expect(admission("restricted-creator", client)).toBeUndefined();
    await inRun("restricted-creator", undefined, async (_identity, admitted) => {
      bindGatewayContextResolver(admitted, () => fixture.context);
      try {
        const tools = await createCreatorTransportTools({
          transport: "embedded",
          config,
          admitted,
          // Tool access does not grant Gateway-wide management admission.
          senderIsOwner: true,
        });
        await tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "add",
          job: {
            name: "Restricted caller job",
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "current",
            payload: { kind: "agentTurn", message: "Check status", timeoutSeconds: 0 },
            delivery: { mode: "none" },
          },
        });
        const jobs = await fixture.read();
        expect(jobs).toMatchObject([
          {
            createdActor: CREATOR,
            owner: { agentId: "main", sessionKey: SESSION, accountId: "default" },
            scheduledToolPolicy: {
              mode: "account",
              ownerSessionKey: SESSION,
              ownerAccountId: "default",
            },
            payload: { toolsAllow: ["*"], timeoutSeconds: 0 },
          },
        ]);
        expect(jobs[0]?.payload).not.toHaveProperty("toolsAllowIsDefault");
      } finally {
        clearGatewayContextResolver(admitted);
      }
    });
  });
  it.each([
    ["cli", "local"],
    ["embedded", "local"],
    ["embedded", "remote"],
    ["embedded", "remote-chat"],
  ] as const)(
    "fences a real %s %s creator mutation while its run remains admitted",
    { timeout: 30_000 },
    async (transport, origin) => {
      const config: OpenClawConfig = {
        ...cfg,
        agents: { ...cfg.agents, defaults: { workspace: stateDir } },
        tools: { allow: [AUTOMATIONS_TOOL_NAME] },
      };
      setRuntimeConfigSnapshot(config);
      const entered = createDeferred();
      const release = createDeferred();
      let hold = false;
      const fixture = createCronFixture(async () => {
        if (hold) {
          entered.resolve();
          await release.promise;
        }
        return [];
      }, config);
      const caller = captureGatewayDeviceRevocation(
        fixture.context,
        { deviceId: "creator-device", role: "operator" },
        () => true,
      );
      const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
      client.internal = origin === "local" ? { isLocalClient: true } : { controlUiAdmin: true };
      const runId = `original-${transport}-creator`;
      const creatorAdmission = expectDefined(
        origin === "remote-chat"
          ? resolveGatewayChatCronCreatorAuthorityAdmission({
              runId,
              resolvedSessionKey: SESSION,
              client,
              isCurrent: caller.isCurrent,
              hasExplicitOrigin: false,
              hasRestoredCronContinuation: false,
              isIncognito: false,
              isReconnectResume: false,
              isSystemGenerated: false,
              turnKind: "main",
              isDirectExternalUser: true,
            })
          : admission(runId, client, undefined, caller.isCurrent),
        "fresh operator admission",
      );
      const creator = expectDefined(
        createCronCreatorAuthorityCapability(
          runId,
          creatorAdmission.callerOrigin,
          creatorAdmission.managementEntitlement,
          creatorAdmission.isCurrent,
          undefined,
          creatorAdmission.requesterOwner,
          creatorAdmission.callerScopedCreation,
        ),
        "creator capability",
      );
      // Keep execution live so revocation must travel through the original caller predicate.
      const runAdmission = prepareAgentRunAdmission({
        cfg: config,
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "system", boundary: "cron-creator-caller-test", state: "present" },
        },
      });
      let admittedRun: AdmittedRunContext | undefined;
      let transportTools: CreatorTransportTools | undefined;
      let pending: Promise<unknown> | undefined;
      try {
        const admitted = await runAdmission.admit("gateway", runId);
        admittedRun = admitted;
        const delegated = expectDefined(getAdmittedRunDelegatedAuthority(admitted), "admitted run");
        bindGatewayContextResolver(admitted, () => fixture.context);
        if (transport === "cli") {
          await ensureMcpLoopbackServer(0);
        }
        await runWithCronCreatorAuthorityCapability(creator, async () => {
          const tools = await createCreatorTransportTools({
            transport,
            config,
            admitted,
            creator,
            senderIsOwner: hasGatewayAdminScope(client),
          });
          transportTools = tools;
          const invoke = (name: string) =>
            tools.invoke(AUTOMATIONS_TOOL_NAME, {
              action: "add",
              job: {
                name,
                schedule: { kind: "every", everyMs: 60_000 },
                sessionTarget: "current",
                wakeMode: "next-heartbeat",
                payload: { kind: "agentTurn", message: "Check service health", timeoutSeconds: 0 },
                delivery: { mode: "none" },
              },
            });

          await invoke("Live creator");
          const before = await fixture.read();
          expect(before).toMatchObject([
            {
              name: "Live creator",
              createdActor: CREATOR,
              sessionKey: SESSION,
              sessionTarget: "current",
              payload: {
                kind: "agentTurn",
                timeoutSeconds: 0,
                toolsAllow: ["*"],
              },
              owner: { agentId: "main", sessionKey: SESSION, accountId: "default" },
              scheduledToolPolicy: {
                mode: "account",
                ownerSessionKey: SESSION,
                ownerAccountId: "default",
              },
              toolsAllowProvenance: {
                source: "final-executable-surface",
                callerOrigin: { kind: origin === "local" ? "local" : "unknown" },
              },
            },
          ]);
          expect(before[0]?.payload).not.toHaveProperty("toolsAllowIsDefault");
          expect(before[0]?.runtimeAuthority).toBeUndefined();
          hold = true;
          pending = invoke("Revoked creator");
          const rejected = expect(pending).rejects.toThrow(/authority.*no longer active/i);
          void rejected.catch(() => undefined);
          try {
            await withTestTimeout(
              Promise.race([
                entered.promise,
                pending.then(() => {
                  throw new Error("Creator mutation returned before service validation");
                }),
              ]),
              10_000,
              "Creator mutation did not reach real Cron validation",
            );
            expect(await fixture.read()).toEqual(before);
            invalidateGatewayDeviceRevocation(fixture.context, "creator-device", "operator");
          } finally {
            release.resolve();
            await pending.catch(() => undefined);
          }
          await rejected;
          expect(getAdmittedRunDelegatedAuthority(admitted)).toBe(delegated);
          expect(creator.active).toBe(true);
          expect(creator.signal.aborted).toBe(false);
          expect(await fixture.read()).toEqual(before);
          if (tools.mcpCapture) {
            expect(deactivateMcpLoopbackClientGrantCapture(tools.mcpCapture)).toBe(true);
          }
        });
      } finally {
        release.resolve();
        await pending?.catch(() => undefined);
        if (transportTools?.mcpCapture) {
          revokeMcpLoopbackClientGrant(transportTools.mcpCapture.token);
        }
        try {
          if (transport === "cli") {
            await closeMcpLoopbackServer();
          }
        } finally {
          if (admittedRun) {
            clearGatewayContextResolver(admittedRun);
          }
          runAdmission.close();
          caller.release();
        }
      }
    },
  );
});
