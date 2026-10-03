import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { createAgentHarnessHostCapabilities } from "../agents/harness/host-capability.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { getRuntimeConfig } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../talk/agent-consult-tool.js";
import { loadDeviceIdentity } from "./device-authz.test-helpers.js";
import {
  getGatewayLocalUserIngress,
  readGatewayLocalUserIngressFacts,
} from "./local-user-ingress.js";
import * as callerContext from "./server-methods/gateway-client-identity.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  connectReq,
  rpcReq,
  createGatewaySuiteHarness,
  prepareGatewayReplyRuntimeForTest,
  gatewayReplyMock,
} from "./test-helpers.js";

// Uses the existing suite Gateway: both clients pass a real signed handshake and
// obtain its opaque ingress brand. Only inference is replaced by a fixed action.
export async function runTalkCallerReplay({
  harness,
  runEmbeddedAgent,
  sessionId,
  sessionKey,
  storePath,
  voiceSessionId,
}: {
  harness: Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
  runEmbeddedAgent: MockInstance<typeof import("../agents/embedded-agent.js").runEmbeddedAgent>;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  voiceSessionId: string;
}) {
  const origin = "http://127.0.0.1:" + harness.port;
  const current = getRuntimeConfig();
  const config = {
    ...current,
    gateway: {
      ...current.gateway,
      controlUi: { ...current.gateway?.controlUi, allowedOrigins: [origin] },
    },
    tools: { ...current.tools, exec: { host: "gateway" as const, mode: "full" as const } },
  };
  await prepareGatewayReplyRuntimeForTest({ force: true, config });
  await replaceSessionEntry(
    { agentId: "main", sessionKey, storePath },
    {
      sessionId,
      updatedAt: Date.now(),
      permissionMode: "full",
      execHost: "gateway",
    },
  );
  const identities = {
    writer: loadDeviceIdentity("replay-writer"),
    reader: loadDeviceIdentity("replay-reader"),
  };
  type Caller = keyof typeof identities;
  const sockets: Array<Awaited<ReturnType<typeof harness.openWs>>> = [];
  const connect = async (who: Caller, requestedScopes?: string[]) => {
    const scopes =
      requestedScopes ??
      (who === "writer"
        ? ["operator.read", "operator.write", "operator.talk", "operator.approvals"]
        : ["operator.read", "operator.talk"]);
    const socket = await harness.openWs({ origin });
    sockets.push(socket);
    expect(
      (
        await connectReq(socket, {
          client: { id: "openclaw-control-ui", mode: "webchat", version: "test", platform: "test" },
          scopes,
          caps: ["exec-approvals"],
          deviceIdentityPath: identities[who].identityPath,
          browserOrigin: origin,
          prePairDevice: true,
        })
      ).ok,
    ).toBe(true);
    socket.on("message", (raw) => {
      const event = JSON.parse(rawDataToString(raw));
      if (event.event === "exec.approval.requested") {
        approvals.push(event.payload);
      }
    });
    return socket;
  };
  const clients = new Map<Caller, GatewayClient>();
  const resolve = callerContext.resolveChatSendCallerContext;
  const observeCaller = vi
    .spyOn(callerContext, "resolveChatSendCallerContext")
    .mockImplementation((client, ...rest) => {
      const who = (Object.keys(identities) as Caller[]).find(
        (key) => identities[key].identity.deviceId === client?.connect.device?.id,
      );
      if (who && client) {
        expect(client.internal?.authenticatedOperator).toBe(true);
        expect(client.internal?.syntheticClient).toBeUndefined();
        const facts = readGatewayLocalUserIngressFacts(getGatewayLocalUserIngress(client));
        expect(facts?.ingress).toMatchObject({
          state: "present",
          boundary: "gateway.ws.authenticated-connect",
        });
        expect(facts?.assurance).toContainEqual(
          expect.objectContaining({
            kind: "device-proof",
            rawEvidenceRef: identities[who].identity.deviceId,
          }),
        );
        expect(facts?.invoker).toMatchObject({ state: "present", kind: "person" });
        clients.set(who, client);
      }
      return resolve(client, ...rest);
    });
  const attempts: Array<{ caller: Caller; runId: string; exec: boolean }> = [];
  let hold:
    | {
        started: ReturnType<typeof createDeferred<void>>;
        release: ReturnType<typeof createDeferred<void>>;
      }
    | undefined;
  const approvals: unknown[] = [];
  const outcomes: unknown[] = [];
  const workspace = expectDefined(config.agents?.defaults?.workspace, "suite workspace");
  // Removing an effect marker must not wipe an attested workspace between cells.
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, "README.md"), "Synthetic caller replay workspace.\n");
  const marker = path.join(workspace, "caller-replay-effects");
  const effects = () =>
    fs.readFile(marker, "utf8").catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return "";
      }
      throw error;
    });
  const settled = () =>
    getSessionWorkAdmissionRelease({ scope: storePath, identities: [sessionKey, sessionId] });
  const replies = new Map<string, unknown>();
  gatewayReplyMock.mockImplementation(async (...args) => {
    const result = await getReplyFromConfig(...args);
    replies.set(String(args[0].MessageSid), result);
    return result;
  });
  runEmbeddedAgent.mockImplementation(async (params) => {
    const caller = (Object.keys(identities) as Caller[]).find(
      (key) => identities[key].identity.deviceId === params.approvalReviewerDeviceId,
    );
    if (!caller) {
      throw new Error("Backend lost authenticated requester device");
    }
    const admittedRunContext = await expectDefined(
      params.preparedRunAdmission,
      "real admission",
    ).admit("plugin-harness", "caller-replay-fixed-model");
    const host = createAgentHarnessHostCapabilities({
      pluginId: "caller-replay-fixed-model",
      attempt: {
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        runId: params.runId,
        workspaceDir: params.workspaceDir,
        cwd: params.cwd,
        config: params.config,
        admittedRunContext,
        abortSignal: params.abortSignal,
      },
    });
    try {
      const tools = host.capabilities.bindToolSurface(
        applyEmbeddedAttemptToolsAllow(
          createOpenClawCodingTools({
            config: params.config,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            runId: params.runId,
            cwd: params.cwd,
            workspaceDir: params.workspaceDir,
            sessionPermissionPolicy: {
              root: params.workspaceDir,
              mode: params.permissionMode ?? "read-only",
            },
            runtimeToolAllowlist: params.toolsAllow,
            senderIsOwner: params.senderIsOwner,
            exec: {
              ...params.execOverrides,
              approvalReviewerDeviceId: params.approvalReviewerDeviceId,
              allowBackground: false,
              notifyOnExit: false,
            },
          }),
          params.toolsAllow,
        ),
      );
      const execTool = tools.find((tool) => tool.name === "exec");
      const attempt = {
        caller,
        runId: params.runId,
        exec: Boolean(execTool),
      };
      attempts.push(attempt);
      const gate = hold;
      gate?.started.resolve();
      await gate?.release.promise;
      if (execTool) {
        const result = await execTool.execute(
          "same-action",
          {
            command: "printf 'effect\n' >> caller-replay-effects",
            workdir: workspace,
            yieldMs: 10000,
          },
          params.abortSignal,
        );
        expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
      }
      return {
        payloads: [
          { text: execTool ? "Writer effect completed." : "Caller has no exec capability." },
        ],
        meta: { durationMs: 0 },
      };
    } finally {
      host.close();
    }
  });
  try {
    const peers = { writer: await connect("writer"), reader: await connect("reader") };
    const consult = (who: Caller, callId: string, socket = peers[who]) =>
      rpcReq<{ runId: string }>(socket, "talk.client.toolCall", {
        sessionKey,
        voiceSessionId,
        callId,
        name: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
        args: { question: "Carry out the action." },
      });
    // agent.wait requires write scope; the writer observes this shared session.
    // It does not execute or confer authority on the reader's admitted run.
    const waitRun = async (runId: string | undefined, observer = peers.writer) => {
      const result = await rpcReq(observer, "agent.wait", {
        runId: expectDefined(runId, "accepted run"),
        timeoutMs: 10000,
      });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result.payload?.status, JSON.stringify(result)).toBe("ok");
      await settled();
    };
    for (const order of [
      ["writer", "reader"],
      ["reader", "writer"],
    ] as const) {
      const callId = "shared-" + order.join("-");
      const before = attempts.length;
      await fs.rm(marker, { force: true });
      const first = await consult(order[0], callId);
      if (first.ok) {
        await waitRun(first.payload?.runId);
      }
      const second = await consult(order[1], callId);
      if (second.ok) {
        await waitRun(second.payload?.runId);
      }
      const cell = {
        order,
        firstOk: first.ok,
        secondOk: second.ok,
        admitted: attempts.slice(before).map(({ caller, exec }) => ({ caller, exec })),
        effects: await effects(),
        differentRuns: Boolean(
          first.payload?.runId &&
          second.payload?.runId &&
          first.payload.runId !== second.payload.runId,
        ),
      };
      if (first.ok && second.ok) {
        expect(attempts[before]?.runId).toBe(first.payload?.runId);
        expect(attempts[before + 1]?.runId).toBe(second.payload?.runId);
        for (const attempt of attempts.slice(before)) {
          expect(replies.get(attempt.runId)).toMatchObject({
            text: attempt.exec ? "Writer effect completed." : "Caller has no exec capability.",
          });
        }
      }
      outcomes.push(cell);
      expect.soft(cell).toEqual({
        order,
        firstOk: true,
        secondOk: true,
        admitted: order.map((caller) => ({ caller, exec: caller === "writer" })),
        effects: "effect\n",
        differentRuns: true,
      });
    }
    // Hold actual inference, not admission: retry ACKs and control custody are real.
    await fs.rm(marker, { force: true });
    const beforeHeld = attempts.length;
    hold = { started: createDeferred(), release: createDeferred() };
    const first = await consult("writer", "active-shared");
    const firstFinished = waitRun(first.payload?.runId);
    await Promise.race([
      hold.started.promise,
      firstFinished.then(() => {
        throw new Error("Run finished without entering inference");
      }),
    ]);
    const retransmit = await consult("writer", "active-shared");
    const foreignControl = await rpcReq(peers.reader, "talk.client.steer", {
      sessionKey,
      text: "status",
      mode: "status",
    });
    // A lower-grant socket of the same signed device may observe its existing
    // intent, but must not acquire the original connection's control custody.
    const narrowedActivePeer = await connect("writer", ["operator.read", "operator.talk"]);
    const narrowedActive = await consult("writer", "active-shared", narrowedActivePeer);
    const narrowedControl = await rpcReq(narrowedActivePeer, "talk.client.steer", {
      sessionKey,
      text: "status",
      mode: "status",
    });
    const pendingOther = consult("reader", "active-shared");
    const ownControl = await rpcReq(peers.writer, "talk.client.steer", {
      sessionKey,
      text: "status",
      mode: "status",
    });
    const effectsBeforeRelease = await effects();
    hold.release.resolve();
    hold = undefined;
    const other = await pendingOther;
    await firstFinished;
    if (other.ok) {
      await waitRun(other.payload?.runId);
    }
    const active = {
      sameCallerSameRun: first.payload?.runId === retransmit.payload?.runId,
      narrowedSameCallerSameRun: narrowedActive.payload?.runId === first.payload?.runId,
      narrowedSameCallerControl: narrowedControl.ok,
      differentCallerDifferentRun: Boolean(
        other.payload?.runId && other.payload.runId !== first.payload?.runId,
      ),
      foreignControl: foreignControl.ok,
      ownControl: ownControl.ok,
      effectsBeforeRelease,
    };
    await settled();
    outcomes.push({
      active,
      admitted: attempts.slice(beforeHeld).map(({ caller, exec }) => ({ caller, exec })),
      effects: await effects(),
    });
    expect.soft(active).toEqual({
      sameCallerSameRun: true,
      differentCallerDifferentRun: true,
      narrowedSameCallerSameRun: true,
      narrowedSameCallerControl: false,
      foreignControl: false,
      ownControl: true,
      effectsBeforeRelease: "",
    });
    expect
      .soft(attempts.slice(beforeHeld).map(({ caller }) => caller))
      .toEqual(["writer", "reader"]);
    expect(await effects()).toBe("effect\n");
    // A new socket with the same signed identity/grants replays accepted work.
    const beforeReconnect = attempts.length;
    const closed = once(peers.writer, "close");
    peers.writer.close();
    await closed;
    peers.writer = await connect("writer", [
      "operator.approvals",
      "operator.talk",
      "operator.write",
      "operator.read",
    ]);
    const replay = await consult("writer", "active-shared");
    await settled();
    expect(replay.ok).toBe(false);
    expect(replay.error?.message).toContain("completed before the tool result subscription");
    expect(attempts).toHaveLength(beforeReconnect);
    expect(await effects()).toBe("effect\n");
    const equivalentClosed = once(peers.writer, "close");
    peers.writer.close();
    await equivalentClosed;
    peers.writer = await connect("writer", ["operator.write", "operator.approvals"]);
    const equivalentReplay = await consult("writer", "active-shared");
    if (equivalentReplay.ok) {
      await waitRun(equivalentReplay.payload?.runId);
    }
    await settled();
    const equivalentCell = {
      equivalentReconnectAcceptedAsNew: equivalentReplay.ok,
      equivalentReconnectDispatches: attempts.length - beforeReconnect,
      effects: await effects(),
      approvals: approvals.length,
    };
    console.info("Equivalent-grant reconnect observed:", JSON.stringify(equivalentCell));
    expect(equivalentCell).toEqual({
      equivalentReconnectAcceptedAsNew: false,
      equivalentReconnectDispatches: 0,
      effects: "effect\n",
      approvals: 0,
    });
    expect(equivalentReplay.error?.message).toContain(
      "completed before the tool result subscription",
    );
    const replayDispatches = attempts.length - beforeReconnect;
    // A changed grant is not a new logical request from the same signed caller.
    const narrowedClosed = once(peers.writer, "close");
    peers.writer.close();
    await narrowedClosed;
    peers.writer = await connect("writer", ["operator.write"]);
    const narrowed = await consult("writer", "active-shared");
    if (narrowed.ok) {
      await waitRun(narrowed.payload?.runId);
    }
    await settled();
    const narrowedCell = {
      narrowedRetryAcceptedAsNew: narrowed.ok,
      narrowedRetryDispatches: attempts.length - beforeReconnect,
      effects: await effects(),
      approvals: approvals.length,
    };
    console.info("Narrowed-grant retry observed:", JSON.stringify(narrowedCell));
    expect(narrowedCell).toEqual({
      narrowedRetryAcceptedAsNew: false,
      narrowedRetryDispatches: 0,
      effects: "effect\n",
      approvals: 0,
    });
    expect(narrowed.error?.message).toContain("completed before the tool result subscription");
    expect(clients.get("writer")?.connect.scopes).not.toContain("operator.approvals");
    const beforeFresh = attempts.length;
    const fresh = await consult("writer", "genuinely-new-call");
    if (fresh.ok) {
      await waitRun(fresh.payload?.runId);
    }
    expect(fresh.ok).toBe(true);
    expect(fresh.payload?.runId).not.toBe(first.payload?.runId);
    expect(attempts).toHaveLength(beforeFresh + 1);
    expect(await effects()).toBe("effect\neffect\n");
    outcomes.push({
      reconnectReplayDispatches: replayDispatches,
      narrowedRetryDispatches: narrowedCell.narrowedRetryDispatches,
      newRequestDispatches: attempts.length - beforeFresh,
      effects: await effects(),
      approvals: approvals.length,
    });
    // Keep a separate, genuinely write-authorized observer solely for agent.wait.
    // The read-only action below is still admitted from its own signed socket.
    const runObserver = peers.writer;
    peers.writer = await connect("writer", ["operator.read", "operator.talk"]);
    const beforeReadOnly = attempts.length;
    const beforeReadOnlyEffects = await effects();
    const readOnlyRetry = await consult("writer", "active-shared");
    expect(readOnlyRetry.ok).toBe(false);
    expect(readOnlyRetry.error?.message).toContain("completed before the tool result subscription");
    expect(attempts).toHaveLength(beforeReadOnly);
    const readOnlyFresh = await consult("writer", "new-read-only-call");
    expect(readOnlyFresh.ok).toBe(true);
    await waitRun(readOnlyFresh.payload?.runId, runObserver);
    expect(attempts).toHaveLength(beforeReadOnly + 1);
    expect(attempts.at(-1)).toMatchObject({
      caller: "writer",
      exec: false,
      runId: readOnlyFresh.payload?.runId,
    });
    expect(replies.get(String(readOnlyFresh.payload?.runId))).toMatchObject({
      text: "Caller has no exec capability.",
    });
    expect(await effects()).toBe(beforeReadOnlyEffects);
    const readOnlyClosed = once(peers.writer, "close");
    peers.writer.close();
    await readOnlyClosed;
    peers.writer = await connect("writer", ["operator.read"]);
    const deniedRetry = await consult("writer", "active-shared");
    const deniedFresh = await consult("writer", "new-without-talk");
    for (const result of [deniedRetry, deniedFresh]) {
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("missing scope: operator.talk");
    }
    expect(attempts).toHaveLength(beforeReadOnly + 1);
    expect(await effects()).toBe(beforeReadOnlyEffects);
    outcomes.push({
      readOnlyRetryDispatches: attempts.length - beforeReadOnly - 1,
      freshReadOnlyExec: attempts.at(-1)?.exec,
      methodDeniedRetry: !deniedRetry.ok,
      methodDeniedFresh: !deniedFresh.ok,
      effectsUnchanged: (await effects()) === beforeReadOnlyEffects,
    });
    expect(clients.size).toBe(2);
    expect(clients.get("writer")?.connect.client.id).toBe(clients.get("reader")?.connect.client.id);
    expect(clients.get("writer")?.connect.device?.id).not.toBe(
      clients.get("reader")?.connect.device?.id,
    );
    expect(clients.get("writer")?.authenticatedUserProfile?.profileId).toBe(
      clients.get("reader")?.authenticatedUserProfile?.profileId,
    );
    expect(clients.get("writer")?.connect.scopes).not.toContain("operator.write");
    expect(clients.get("reader")?.connect.scopes).not.toContain("operator.write");
    expect(approvals).toHaveLength(0);
    console.info("Authenticated caller replay observed:", JSON.stringify(outcomes));
  } finally {
    hold?.release.resolve();
    observeCaller.mockRestore();
    for (const socket of sockets) {
      socket.close();
    }
    await settled();
  }
}
