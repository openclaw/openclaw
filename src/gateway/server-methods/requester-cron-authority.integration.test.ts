import { readFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import {
  type AdmittedRunContext,
  getAdmittedRunDelegatedAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
import type { CronCreatorAuthorityCapability } from "../../agents/cron-creator-authority-context.js";
import { bindCronManagementGrant } from "../../agents/cron-creator-authority-context.js";
import * as hostFileWrite from "../../agents/host-file-write.js";
import { makeSettledChild } from "../../agents/subagents/announce/subagent-announce.requester-settle-wake.test-support.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import { settleRequesterTurnAfterSessionSpawns } from "../../agents/subagents/registry/subagent-registry-requester-yield.js";
import {
  createRequesterInitialTransferFixture,
  markRequesterTurnYieldedWithAuthority,
} from "../../agents/subagents/registry/subagent-registry-requester-yield.test-support.js";
import {
  captureRequesterContinuationCaller,
  revokeRequesterCronAuthority,
} from "../../agents/subagents/requester-cron-authority.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import { isConfiguredCommandOwner } from "../../auto-reply/command-auth.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { resolveMcpLoopbackClientGrant, revokeMcpLoopbackClientGrant } from "../mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../mcp-http.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createSyntheticPluginRuntimeClient } from "../server-plugin-runtime-client.js";
import {
  SESSION,
  SESSION_ID,
  cfg,
  stateDir,
  cron,
  admission,
  type RequesterRun,
  inRun,
  createCronFixture,
  type CreatorTransportTools,
  createCreatorTransportTools,
  installRequesterCronAuthorityTestHooks,
} from "./requester-cron-authority.test-support.js";
import type { RespondFn } from "./types.js";

// Attached-node inventory is unrelated to these original-caller and Cron commit boundaries.
vi.mock("../../agents/node-exec-availability.js", () => ({
  loadNodeExecAvailability: async () => ({ cacheKey: "no-nodes", isAvailable: () => false }),
}));

installRequesterCronAuthorityTestHooks();

async function withSuccessor<T>(admin: boolean | "channel-owner", run: RequesterRun<T>) {
  const originalRunId = "original-requester";
  const requesterTurn = {
    requesterSessionKey: SESSION,
    requesterAgentId: "main",
    requesterTurnRunId: originalRunId,
  };
  const child = makeSettledChild({
    ...requesterTurn,
    runId: "settled-child",
    requesterSettleWake: undefined,
    completion: { required: true, resultText: "Maintenance review complete" },
  });
  subagentRuns.set(child.runId, child);
  const runs = subagentRuns;
  const transfer = createRequesterInitialTransferFixture(runs);
  const requester = createSyntheticPluginRuntimeClient({
    scopes: admin ? ["operator.admin"] : ["operator.write"],
  });
  // The authenticated connection boundary supplies these facts; no model or
  // child result may promote the ordinary continuation below.
  requester.internal = admin === true ? { controlUiAdmin: true } : {};
  const admitted =
    admin === "channel-owner"
      ? {
          runId: originalRunId,
          callerOrigin: { kind: "unknown" as const },
          managementEntitlement: {
            source: "channel-owner" as const,
            isCurrent: () =>
              isConfiguredCommandOwner(getRuntimeConfig(), {
                channel: "discord",
                senderId: "owner-1",
              }),
          },
        }
      : admission(originalRunId, requester);
  if (admin === "channel-owner") {
    setRuntimeConfigSnapshot({ ...cfg, commands: { ownerAllowFrom: ["discord:owner-1"] } });
  }
  await inRun(originalRunId, admitted, async () => {
    expect(
      await markRequesterTurnYieldedWithAuthority({
        ...requesterTurn,
        runs,
        transfer,
      }),
    ).toBe(1);
  });
  expect(
    await settleRequesterTurnAfterSessionSpawns({
      ...requesterTurn,
      requesterYielded: true,
      acceptedSessionSpawns: [
        {
          runId: child.runId,
          childSessionKey: child.childSessionKey,
          expectsCompletionMessage: true,
        },
      ],
      runs,
      transfer,
      schedule: () => {},
    }),
  ).toBe(true);
  const runId = "successor-requester";
  return await captureRequesterContinuationCaller({
    requesterSessionKey: SESSION,
    requesterSessionId: SESSION_ID,
    requesterAgentId: "main",
    batch: [expectDefined(runs.get(child.runId), "published requester child")],
    rearmGeneration: runs.get(child.runId)?.requesterSettleWake?.rearmGeneration,
    runId,
    isCurrent: () => true,
  }).run(() =>
    inRun(
      runId,
      admission(runId, createSyntheticPluginRuntimeClient(), child.childSessionKey),
      async (identity, admittedRun, creator) => {
        // Queue acceptance retires the committed outbox before tools finish.
        // Its fresh admitted run must now own management and revocation.
        expect(creator?.callerScopedCreation).toBeUndefined();
        if (admin) {
          const management = bindCronManagementGrant(runId);
          expect(management?.managementOnly).toBe(true);
          expect(() => management?.mint("cron.add")).toThrow("management-only");
        }
        await mutateSubagentRuns(
          [child.runId],
          () => ({
            value: undefined,
            postimages: new Map([[child.runId, null]]),
          }),
          {
            runs,
            context: captureOpenClawStateWorkerContext(),
            assertCurrent: resolveAdmittedRunActiveAssertion(admittedRun),
          },
        );
        return await run(identity, admittedRun, creator);
      },
    ),
  );
}

async function withTransport(
  transport: "cli" | "embedded",
  config: OpenClawConfig,
  context: ReturnType<typeof createCronFixture>["context"],
  run: (
    tools: CreatorTransportTools,
    admitted: AdmittedRunContext,
    creator: CronCreatorAuthorityCapability,
  ) => Promise<void>,
) {
  // Construct the listener outside the requester's Cron scope.
  if (transport === "cli") {
    await ensureMcpLoopbackServer(0);
  }
  try {
    await withSuccessor(true, async (_identity, admitted, capability) => {
      const creator = expectDefined(capability, "requester continuation capability");
      bindGatewayContextResolver(admitted, () => context);
      let tools: CreatorTransportTools | undefined;
      try {
        tools = await createCreatorTransportTools({
          transport,
          config,
          admitted,
          creator,
          senderIsOwner: true,
        });
        await run(tools, admitted, creator);
      } finally {
        if (tools?.mcpCapture) {
          revokeMcpLoopbackClientGrant(tools.mcpCapture.token);
        }
        clearGatewayContextResolver(admitted);
      }
    });
  } finally {
    if (transport === "cli") {
      await closeMcpLoopbackServer();
    }
  }
}

async function createStoredJob(
  listConfiguredChannels: () => Promise<string[]> = async () => [],
  config: OpenClawConfig = cfg,
) {
  const { context, read } = createCronFixture(listConfiguredChannels, config);
  const job = await cron.add(
    {
      name: "Maintenance",
      enabled: false,
      schedule: { kind: "every", everyMs: 1_800_000 },
      sessionTarget: "isolated",
      agentId: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "Check service health" },
      delivery: { mode: "none" },
      owner: { agentId: "main", sessionKey: "agent:main:telegram:dm:42", accountId: "telegram" },
    },
    {
      scheduledToolPolicy: { version: 1, mode: "trusted" },
      captureRuntimeAuthority: () => ({
        version: 1,
        runtimeId: "codex",
        namespace: "codex.apps",
        payload: { apps: [{ id: "calendar" }] },
      }),
    },
  );
  const before = await read();
  const runtimeAuthority = before[0]!.runtimeAuthority;
  expect(runtimeAuthority).toBeDefined();
  return {
    context,
    before,
    read,
    runtimeAuthority,
    readRuntimeAuthority: async () => (await read())[0]!.runtimeAuthority,
    update: (identity: AgentRuntimeIdentity) => updateWithGrantFor("cron.update", identity),
    updateWithGrantFor,
  };

  async function updateWithGrantFor(grantMethod: string, identity: AgentRuntimeIdentity) {
    const management = bindCronManagementGrant(identity.operationalRunInstance.runId);
    // A configured channel owner's turn reaches the Gateway without operator.admin.
    const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
    client.internal!.agentRuntimeIdentity = {
      ...identity,
      cronManagementGrant: management?.mint(grantMethod),
    };
    const respond = vi.fn<RespondFn>();
    const params = {
      id: job.id,
      patch: {
        name: "Reviewed maintenance",
        enabled: true,
        schedule: { kind: "every", everyMs: 3_600_000 },
        payload: { kind: "agentTurn", message: "Reviewed health check" },
        delivery: { mode: "none" },
      },
    };
    // The router applies the method-scope fence before the cron handler redeems the grant.
    await handleGatewayRequest({
      req: { type: "req", id: "update", method: "cron.update", params },
      client,
      context,
      respond,
      isWebchatConnect: () => false,
    });
    return expectDefined(respond.mock.calls[0], "cron update response");
  }
}

describe("requester continuation persisted automation management", () => {
  it("blocks creation after requester handoff", async () => {
    const config: OpenClawConfig = { ...cfg, tools: { allow: [AUTOMATIONS_TOOL_NAME] } };
    setRuntimeConfigSnapshot(config);
    const fixture = createCronFixture(undefined, config);
    await withTransport("embedded", config, fixture.context, async (tools) => {
      await expect(
        tools.invoke(AUTOMATIONS_TOOL_NAME, {
          action: "add",
          job: {
            name: "Must not be created",
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "current",
            payload: { kind: "agentTurn", message: "Check status", timeoutSeconds: 0 },
            delivery: { mode: "none" },
          },
        }),
      ).rejects.toThrow("This turn can only list, get, update, run, or remove automations");
      expect(await fixture.read()).toEqual([]);
    });
  });
  it.each(["cli", "embedded"] as const)(
    "keeps %s file writes admitted after Cron revocation",
    { timeout: 30_000 },
    async (transport) => {
      const config: OpenClawConfig = {
        ...cfg,
        agents: { ...cfg.agents, defaults: { workspace: stateDir } },
        tools: { allow: [AUTOMATIONS_TOOL_NAME, "write"], fs: { workspaceOnly: false } },
      };
      setRuntimeConfigSnapshot(config);
      const fixture = await createStoredJob(undefined, config);
      await withTransport(transport, config, fixture.context, async (tools, admitted, creator) => {
        const isCronCurrent = expectDefined(creator.isCurrent, "requester Cron currentness");
        const delegated = expectDefined(getAdmittedRunDelegatedAuthority(admitted), "admitted run");
        const assertRunActive = expectDefined(
          resolveAdmittedRunActiveAssertion(admitted),
          "admitted run assertion",
        );
        const mcpGrant = tools.mcpCapture
          ? expectDefined(resolveMcpLoopbackClientGrant(tools.mcpCapture), "live MCP grant")
          : undefined;
        expect(isCronCurrent()).toBe(true);
        const committedPath = path.join(stateDir, `committed-${transport}.txt`);
        const laterPath = path.join(stateDir, `continued-${transport}.txt`);
        const content = "Independent file work remains admitted.\n";
        const write = async (file: string) => {
          await expect(tools.invoke("write", { path: file, content })).resolves.toMatchObject({
            content: [{ type: "text", text: expect.stringContaining("Successfully wrote") }],
          });
          expect(await readFile(file, "utf8")).toBe(content);
        };
        const originalWriteHostFile = hostFileWrite.writeHostFile;
        let revokedAcrossWrite = false;
        const writeSpy = vi
          .spyOn(hostFileWrite, "writeHostFile")
          .mockImplementation(async (...args) => {
            await originalWriteHostFile(...args);
            if (args[0] === committedPath) {
              // Retire only Cron management after the owned file has actually committed.
              revokeRequesterCronAuthority(SESSION);
              revokedAcrossWrite = true;
            }
          });
        try {
          await write(committedPath);
          expect(revokedAcrossWrite).toBe(true);
          expect(isCronCurrent()).toBe(false);
          expect(getAdmittedRunDelegatedAuthority(admitted)).toBe(delegated);
          expect(assertRunActive).not.toThrow();
          expect(creator).toMatchObject({ active: true, signal: { aborted: false } });
          if (mcpGrant) {
            expect(mcpGrant.isCurrent()).toBe(true);
          }
          await write(laterPath);
          await expect(
            tools.invoke(AUTOMATIONS_TOOL_NAME, {
              action: "update",
              jobId: fixture.before[0]!.id,
              job: { name: "Must not persist after requester revocation" },
            }),
          ).rejects.toThrow(/Automation (caller authority is no longer active|admin grant)/i);
          expect(await fixture.read()).toEqual(fixture.before);
        } finally {
          writeSpy.mockRestore();
        }
      });
    },
  );

  it.each([
    [true, "cron.update"],
    [false, "cron.update"],
    ["channel-owner", "cron.update"],
    ["channel-owner", "cron.remove"],
  ] as const)("requires admitted manager %s and matching grant %s", async (admin, grantMethod) => {
    const fixture = await createStoredJob();
    const [ok, result, error] = await withSuccessor(admin, (identity) =>
      fixture.updateWithGrantFor(grantMethod, identity),
    );
    const permitted = Boolean(admin) && grantMethod === "cron.update";
    expect(ok).toBe(permitted);
    if (permitted) {
      expect(result).toMatchObject({ name: "Reviewed maintenance", enabled: true });
      expect(await fixture.read()).toMatchObject([
        {
          name: "Reviewed maintenance",
          enabled: true,
          scheduledToolPolicy: { version: 1, mode: "trusted" },
          owner: fixture.before[0]!.owner,
          schedule: { kind: "every", everyMs: 3_600_000 },
          payload: { kind: "agentTurn", message: "Reviewed health check" },
        },
      ]);
      expect(await fixture.readRuntimeAuthority()).toEqual(fixture.runtimeAuthority);
    } else {
      // An absent or wrong-method grant stops at the method-scope fence.
      expect(error).toMatchObject({ message: "missing scope: operator.admin" });
      expect(await fixture.read()).toEqual(fixture.before);
    }
  });

  it.each(["fresh user turn", "session reset", "global owner removal"])(
    "rejects %s during update validation",
    async (reason) => {
      const entered = createDeferred();
      const release = createDeferred();
      let hold = false;
      const fixture = await createStoredJob(async () => {
        if (hold) {
          entered.resolve();
          await release.promise;
        }
        return [];
      });
      hold = true;
      const update = withSuccessor(
        reason === "global owner removal" ? "channel-owner" : true,
        fixture.update,
      );
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          update,
          "Update returned before service validation",
        );
        expect(await fixture.read()).toEqual(fixture.before);
        if (reason === "global owner removal") {
          setRuntimeConfigSnapshot(cfg);
        } else if (reason === "fresh user turn") {
          const requester = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
          requester.internal = {};
          admission("new-user-turn", requester);
        } else {
          replaceSessionEntrySync(
            { sessionKey: SESSION },
            { sessionId: SESSION_ID, updatedAt: 2, lifecycleRevision: "reset" },
          );
        }
      } finally {
        release.resolve();
        // Join the real mutation before teardown, without replacing an assertion failure.
        await update.catch(() => undefined);
      }
      const [ok, , error] = await update;
      expect({ ok, error }).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: expect.stringContaining("Automation admin grant"),
        },
      });
      expect(await fixture.read()).toEqual(fixture.before);
    },
  );
});
