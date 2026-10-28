import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import {
  closeAdmittedRunDelegatedAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../../agents/admitted-run-context.js";
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
import { withoutGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { isConfiguredCommandOwner } from "../../auto-reply/command-auth.js";
import { getRuntimeConfig, setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveExecApprovalsPath } from "../../infra/exec-approvals-config.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { revokeMcpLoopbackClientGrant } from "../mcp-grant-store.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "../mcp-http.js";
import { dispatchGatewayRequestInProcess } from "../server-in-process-dispatch.js";
import {
  coreGatewayHandlers,
  createRequestGatewayMethodRegistry,
  handleGatewayRequest,
} from "../server-methods.js";
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
  await inRun(originalRunId, admitted, () =>
    markRequesterTurnYieldedWithAuthority({ ...requesterTurn, runs, transfer }),
  );
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
  });
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
        // Explicitly remove the old cohort to exercise bound-scope independence.
        // This lifetime regression does not model queue ACK retiring a product outbox.
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
  run: (tools: CreatorTransportTools) => Promise<void>,
) {
  // Construct the listener outside the requester's Cron scope.
  if (transport === "cli") {
    await ensureMcpLoopbackServer();
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
        await run(tools);
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
  it("keeps recovery reads scoped and withholds a record when authority closes during its read", async ({
    signal,
  }) => {
    const config: OpenClawConfig = { ...cfg, tools: { allow: [AUTOMATIONS_TOOL_NAME] } };
    setRuntimeConfigSnapshot(config);
    const fixture = createCronFixture(undefined, config);
    const addOwnedJob = (sessionKey: string, name: string) =>
      cron.add(
        {
          name,
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "current",
          sessionKey,
          agentId: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: name, toolsAllow: [] },
          delivery: { mode: "none" },
          owner: { agentId: "main", sessionKey, accountId: "default" },
        },
        {
          scheduledToolPolicy: {
            version: 1,
            mode: "account",
            ownerSessionKey: sessionKey,
            ownerAccountId: "default",
          },
        },
      );
    const own = await addOwnedJob(SESSION, "Recovery-visible record");
    const foreign = await addOwnedJob("agent:main:another-conversation", "Private foreign record");
    const responses = vi.fn<RespondFn>();
    const get = expectDefined(coreGatewayHandlers["cron.get"], "cron.get handler");
    fixture.context.getGatewayMethodRegistry = () =>
      createRequestGatewayMethodRegistry({
        "cron.get": (options) =>
          get({
            ...options,
            respond: (...args) => {
              responses(...args);
              options.respond(...args);
            },
          }),
      });

    await inRun("recovery-inspection", undefined, async (_identity, admitted) => {
      bindGatewayContextResolver(admitted, () => fixture.context);
      const entered = createDeferred();
      const release = createDeferred();
      const readJob = cron.readJob.bind(cron);
      let holdRead = false;
      const readSpy = vi.spyOn(cron, "readJob").mockImplementation(async (id) => {
        const recorded = await readJob(id);
        if (holdRead) {
          expect(recorded?.id).toBe(own.id);
          entered.resolve();
          await withinTest(release.promise, signal);
        }
        return recorded;
      });
      let pending: Promise<unknown> | undefined;
      try {
        const tools = await createCreatorTransportTools({
          transport: "embedded",
          config,
          admitted,
          senderIsOwner: false,
          forceRestartSafeTools: true,
        });
        const inspect = (jobId: string) =>
          tools.invoke(AUTOMATIONS_TOOL_NAME, { action: "get", jobId });
        await expect(inspect(own.id)).resolves.toMatchObject({
          details: { id: own.id, name: own.name, enabled: false },
        });
        expect(responses).toHaveBeenLastCalledWith(
          true,
          expect.objectContaining({ id: own.id, name: own.name }),
          undefined,
        );
        await expect(inspect(foreign.id)).rejects.toThrow("cron job not found");
        expect(responses).toHaveBeenLastCalledWith(false, undefined, expect.anything());
        responses.mockClear();

        holdRead = true;
        pending = inspect(own.id);
        await withinTest(
          awaitGateBeforeSettlement(entered.promise, pending, "Read settled before its owner gate"),
          signal,
        );
        expect(closeAdmittedRunDelegatedAuthority(admitted)).toBe(true);
        release.resolve();
        await expect(pending).rejects.toThrow(/authority|admitted run/i);
        expect(responses).toHaveBeenCalledExactlyOnceWith(
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            message: expect.stringMatching(/authority|admitted run/i),
          }),
        );
      } finally {
        release.resolve();
        await pending?.catch(() => undefined);
        readSpy.mockRestore();
        clearGatewayContextResolver(admitted);
      }
    });
  });

  it("rejects a socket stream request without its own exec policy", async () => {
    const fixture = createCronFixture();
    await inRun("socket-stream-policy", undefined, async (identity) => {
      const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
      client.internal!.agentRuntimeIdentity = identity;
      const respond = vi.fn<RespondFn>();
      await withoutGatewayToolCallerIdentity(async () => {
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "stream-policy",
            method: "cron.add",
            params: {
              name: "Unauthorized stream",
              enabled: true,
              schedule: { kind: "stream", command: ["synthetic-watcher"] },
              sessionTarget: "current",
              payload: { kind: "agentTurn", message: "Watch events", toolsAllow: ["read"] },
              delivery: { mode: "none" },
            },
          },
          client,
          context: fixture.context,
          respond,
          isWebchatConnect: () => false,
        });
      });
      const [ok, , error] = expectDefined(respond.mock.calls[0], "stream policy response");
      expect(ok).toBe(false);
      expect(error?.message).toContain("require the creator turn");
      expect(await fixture.read()).toEqual([]);
    });
  });

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
      ).rejects.toThrow(
        "This turn can only list, inspect, update, run, remove, or bind existing automations",
      );
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
      await withTransport(transport, config, fixture.context, async (tools) => {
        const committedPath = path.join(stateDir, `committed-${transport}.txt`);
        const laterPath = path.join(stateDir, `continued-${transport}.txt`);
        const content = "Independent file work remains admitted.\n";
        const write = async (file: string) => {
          await tools.invoke("write", { path: file, content });
          expect(await readFile(file, "utf8")).toBe(content);
        };
        const originalWriteHostFile = hostFileWrite.writeHostFile;
        using _ = vi.spyOn(hostFileWrite, "writeHostFile").mockImplementation(async (...args) => {
          await originalWriteHostFile(...args);
          if (args[0] === committedPath) {
            // Retire only Cron management after the owned file has actually committed.
            revokeRequesterCronAuthority(SESSION);
          }
        });
        await write(committedPath);
        await write(laterPath);
        await expect(
          tools.invoke(AUTOMATIONS_TOOL_NAME, {
            action: "update",
            jobId: fixture.before[0]!.id,
            job: { name: "Must not persist after requester revocation" },
          }),
        ).rejects.toThrow(/Automation (caller authority is no longer active|admin grant)/i);
        expect(await fixture.read()).toEqual(fixture.before);
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

describe("automation stream exec policy at persistence", () => {
  it.each([
    { action: "add", fullSession: false, pendingLegacyApprovals: false },
    { action: "add", fullSession: true, pendingLegacyApprovals: false },
    { action: "add", fullSession: true, pendingLegacyApprovals: true },
    { action: "management update", fullSession: false, pendingLegacyApprovals: false },
  ] as const)(
    "rechecks host policy for $action with explicit full session=$fullSession and pending legacy approvals=$pendingLegacyApprovals",
    async ({ action, fullSession, pendingLegacyApprovals }) => {
      const config: OpenClawConfig = {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: { workspace: stateDir, sandbox: { mode: "off" } },
        },
        tools: {
          allow: [AUTOMATIONS_TOOL_NAME, "exec"],
          exec: { host: "gateway", security: "full", ask: "off" },
        },
        cron: { triggers: { enabled: true } },
      };
      setRuntimeConfigSnapshot(config);
      const entered = createDeferred();
      const release = createDeferred();
      let hold = false;
      let barrierCount = 0;
      const fixture = createCronFixture(async () => {
        if (hold) {
          barrierCount += 1;
          entered.resolve();
          await release.promise;
        }
        return [];
      }, config);
      const operator = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
      // The connection boundary admits an ordinary local operator; mutations
      // below still run through a separately admitted agent identity.
      operator.internal = { isLocalClient: true, operatorRoleActor: { kind: "system" } };
      const rpc = <T>(method: string, params: unknown) =>
        withoutGatewayToolCallerIdentity(() =>
          dispatchGatewayRequestInProcess<T>(method, params, {
            client: operator,
            context: fixture.context,
            hasCurrentClientAuthority: () => true,
          }),
        );
      const setPolicy = async (security: "full" | "deny", ask: "off" | "always") => {
        const previous = await rpc<{ hash: string }>("exec.approvals.get", {});
        await rpc("exec.approvals.set", {
          baseHash: previous.hash,
          file: { version: 1, defaults: { security, ask } },
        });
        const current = await rpc<{ file: { defaults: { security: string; ask: string } } }>(
          "exec.approvals.get",
          {},
        );
        expect(current.file.defaults).toMatchObject({ security, ask });
      };
      const streamJob = (name: string) => ({
        name,
        enabled: true,
        schedule: {
          kind: "stream",
          command: [process.execPath, "-e", `process.stdout.write(${JSON.stringify(name)})`],
        },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "Synthetic stream policy test" },
      });
      await setPolicy("full", "off");
      const legacyApprovalsPath = resolveExecApprovalsPath();
      const legacyApprovalsBytes = JSON.stringify({
        version: 1,
        defaults: { security: "deny", ask: "always" },
      });
      if (pendingLegacyApprovals) {
        // The operator RPC cached absence in this process; the worker has not
        // read approvals yet and must preserve the explicit full-session exemption.
        await writeFile(legacyApprovalsPath, legacyApprovalsBytes, { mode: 0o600 });
      }
      const stored =
        action === "management update"
          ? await rpc<{ id: string }>("cron.add", {
              ...streamJob("operator-created"),
              enabled: false,
            })
          : undefined;
      const exercise: RequesterRun<void> = async (_identity, admitted, creator) => {
        bindGatewayContextResolver(admitted, () => fixture.context);
        let pending: Promise<{ ok: boolean; error?: unknown }> | undefined;
        try {
          const tools = await createCreatorTransportTools({
            transport: "embedded",
            config,
            admitted,
            creator,
            senderIsOwner: true,
            ...(fullSession
              ? { sessionPermissionPolicy: { mode: "full" as const, root: stateDir } }
              : {}),
          });
          const invoke = (name: string) =>
            tools.invoke(AUTOMATIONS_TOOL_NAME, {
              action: stored ? "update" : "add",
              ...(stored ? { jobId: stored.id } : {}),
              job: streamJob(name),
            });
          await invoke("before-restriction");
          expect((await fixture.read()).map((job) => job.name)).toContain("before-restriction");
          if (stored) {
            await rpc("cron.update", { id: stored.id, patch: { enabled: false } });
          }
          const before = await fixture.read();
          hold = true;
          pending = invoke("during-restriction").then(
            () => ({ ok: true }),
            (error: unknown) => ({ ok: false, error }),
          );
          await Promise.race([
            entered.promise,
            pending.then(() => {
              throw new Error("Stream mutation settled before service validation");
            }),
          ]);
          await setPolicy("deny", "always");
          hold = false;
          release.resolve();
          const outcome = await pending;
          expect(barrierCount).toBe(1);
          if (fullSession) {
            expect(outcome).toEqual({ ok: true });
            await invoke("after-restriction");
            expect((await fixture.read()).map((job) => job.name)).toEqual([
              "before-restriction",
              "during-restriction",
              "after-restriction",
            ]);
          } else {
            expect(outcome.ok).toBe(false);
            expect(String(outcome.error)).toContain("Gateway exec authority");
            expect(await fixture.read()).toEqual(before);
            await expect(invoke("after-restriction")).rejects.toThrow("Gateway exec authority");
            expect(await fixture.read()).toEqual(before);
          }
        } finally {
          hold = false;
          release.resolve();
          await pending;
          clearGatewayContextResolver(admitted);
        }
      };
      if (stored) {
        await withSuccessor(true, exercise);
      } else {
        const runId = "stream-policy-creator";
        await inRun(
          runId,
          expectDefined(admission(runId, operator), "local stream creator admission"),
          exercise,
        );
      }
      if (pendingLegacyApprovals) {
        expect(await readFile(legacyApprovalsPath, "utf8")).toBe(legacyApprovalsBytes);
      }
    },
  );
});
