import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, vi, type MockInstance } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createOpenClawCodingTools } from "../agents/agent-tools.js";
import { createHostWorkspaceWriteTool } from "../agents/agent-tools.read.js";
import { createExecTool } from "../agents/bash-tools.js";
import { applyEmbeddedAttemptToolsAllow } from "../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { createAgentHarnessHostCapabilities } from "../agents/harness/host-capability.js";
import { projectEffectiveExecPolicy } from "../agents/session-permission-exec-mode.js";
import { getRuntimeConfig } from "../config/config.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { captureSessionControllerSettlement } from "../sessions/session-controller.lifecycle.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../talk/agent-consult-tool.js";
import { loadDeviceIdentity } from "./device-authz.test-helpers.js";
import {
  getGatewayLocalUserIngress,
  readGatewayLocalUserIngressFacts,
} from "./local-user-ingress.js";
import * as callerContext from "./server-methods/gateway-client-identity.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { createTalkClientAgentConsultRunner } from "./talk/client-agent-consult.js";
import { resolveTalkAgentConsultAuthority } from "./talk/client-gateway-control.js";
import { retainTalkClientRunAuthority } from "./talk/client-run-authority.js";
import { readLegacyVoiceBinding } from "./talk/handlers/client-legacy-voice-bindings.js";
import { prepareTalkSessionTarget } from "./talk/session-target.js";
import {
  connectReq,
  rpcReq,
  createGatewaySuiteHarness,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";

type EmbeddedRun = typeof import("../agents/embedded-agent.js").runEmbeddedAgent;

async function openActionHost(
  params: Parameters<EmbeddedRun>[0],
  pluginId: string,
  agentId = params.agentId,
  abortSignal?: AbortSignal,
) {
  const { sessionKey, sessionId, runId, workspaceDir, cwd, config } = params;
  const execution = { agentId, sessionKey, sessionId, runId, workspaceDir, cwd, config };
  const admittedRunContext = await expectDefined(
    params.preparedRunAdmission,
    "real admission",
  ).admit("plugin-harness", pluginId);
  const host = createAgentHarnessHostCapabilities({
    pluginId,
    attempt: { ...execution, admittedRunContext, abortSignal },
  });
  return { execution, host };
}

async function prepareActionSession(
  target: Parameters<typeof replaceSessionEntry>[0],
  sessionId: string,
  origin?: string,
) {
  const current = getRuntimeConfig();
  const config = {
    ...current,
    ...(origin
      ? {
          gateway: {
            ...current.gateway,
            controlUi: { ...current.gateway?.controlUi, allowedOrigins: [origin] },
          },
        }
      : {}),
    tools: { ...current.tools, exec: { host: "gateway" as const, mode: "full" as const } },
  };
  await prepareGatewayReplyRuntimeForTest({ force: true, config });
  await replaceSessionEntry(target, {
    sessionId,
    updatedAt: Date.now(),
    permissionMode: "full",
    execHost: "gateway",
  });
  return config;
}

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
  runEmbeddedAgent: MockInstance<EmbeddedRun>;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  voiceSessionId: string;
}) {
  const origin = "http://127.0.0.1:" + harness.port;
  const config = await prepareActionSession(
    { agentId: "main", sessionKey, storePath },
    sessionId,
    origin,
  );
  const identities = {
    writer: loadDeviceIdentity("replay-writer"),
    reader: loadDeviceIdentity("replay-reader"),
  };
  type Caller = keyof typeof identities;
  const callerForDevice = (deviceId: string | undefined) =>
    (["writer", "reader"] as const).find((who) => identities[who].identity.deviceId === deviceId);
  const sockets: Array<Awaited<ReturnType<typeof harness.openWs>>> = [];
  const connect = async (who: Caller, requestedScopes?: string[]) => {
    const scopes =
      requestedScopes ??
      (who === "writer"
        ? ["operator.read", "operator.write", "operator.talk", "operator.approvals"]
        : ["operator.read", "operator.talk"]);
    const socket = await harness.openWs({ origin });
    sockets.push(socket);
    const connected = await connectReq(socket, {
      client: { id: "openclaw-control-ui", mode: "webchat", version: "test", platform: "test" },
      scopes,
      caps: ["exec-approvals"],
      deviceIdentityPath: identities[who].identityPath,
      browserOrigin: origin,
      prePairDevice: true,
    });
    expect(connected).toMatchObject({ ok: true });
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
      const who = callerForDevice(client?.connect.device?.id);
      if (who && client) {
        expect(client.internal?.authenticatedOperator).toBe(true);
        expect(client.internal?.syntheticClient).toBeUndefined();
        const facts = readGatewayLocalUserIngressFacts(getGatewayLocalUserIngress(client));
        expect(facts).toMatchObject({
          ingress: { state: "present", boundary: "gateway.ws.authenticated-connect" },
          assurance: expect.arrayContaining([
            expect.objectContaining({
              kind: "device-proof",
              rawEvidenceRef: identities[who].identity.deviceId,
            }),
          ]),
          invoker: { state: "present", kind: "person" },
        });
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
  const expectEffects = async (dispatches: number, text: string) => {
    expect(attempts).toHaveLength(dispatches);
    expect(await effects()).toBe(text);
  };
  const settled = () =>
    captureSessionControllerSettlement({
      scope: storePath,
      identities: [sessionKey, sessionId],
      agentId: "main",
    });
  runEmbeddedAgent.mockImplementation(async (params) => {
    const caller = callerForDevice(params.approvalReviewerDeviceId);
    if (!caller) {
      throw new Error("Backend lost authenticated requester device");
    }
    const { execution, host } = await openActionHost(
      params,
      "caller-replay-fixed-model",
      params.agentId,
      params.abortSignal,
    );
    try {
      const tools = host.capabilities.bindToolSurface(
        applyEmbeddedAttemptToolsAllow(
          createOpenClawCodingTools({
            ...execution,
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
      attempts.push({ caller, runId: params.runId, exec: Boolean(execTool) });
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
        payloads: [{ text: "Done." }],
        meta: { durationMs: 0 },
      };
    } finally {
      host.close();
    }
  });
  let legacyVoiceForCleanup: string | undefined;
  const legacyBinding = () =>
    readLegacyVoiceBinding(
      expectDefined(clients.get("writer")?.connId, "legacy caller connection"),
      sessionKey,
    );
  const closeVoice = async (socket: (typeof sockets)[number], id: string | undefined) => {
    const result = await rpcReq(socket, "talk.client.close", {
      sessionKey,
      voiceSessionId: expectDefined(id, "legacy voice binding"),
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  };
  try {
    const peers = { writer: await connect("writer"), reader: await connect("reader") };
    const reconnectWriter = async (scopes?: string[]) => {
      const closed = once(peers.writer, "close");
      peers.writer.close();
      await closed;
      peers.writer = await connect("writer", scopes);
    };
    const steer = (socket: (typeof peers)[Caller]) =>
      rpcReq(socket, "talk.client.steer", { sessionKey, text: "status", mode: "status" });
    const consult = (who: Caller, callId: string, socket = peers[who], legacy = false) =>
      rpcReq<{ runId: string }>(socket, "talk.client.toolCall", {
        sessionKey,
        ...(legacy ? {} : { voiceSessionId }),
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
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, payload: { status: "ok" } });
      await settled();
    };
    const finishAccepted = async (result: Awaited<ReturnType<typeof consult>>) => {
      if (result.ok) {
        await waitRun(result.payload?.runId);
      }
    };
    const runFresh = async (callId: string, legacy = false, observer = peers.writer) => {
      const result = await consult("writer", callId, peers.writer, legacy);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      await waitRun(result.payload?.runId, observer);
      return result;
    };
    const expectCompletedReplay = async (
      result: Awaited<ReturnType<typeof consult>>,
      dispatches: number,
      effectText: string,
    ) => {
      await finishAccepted(result);
      await settled();
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: "Realtime agent consult completed before the tool result subscription started.",
        },
      });
      await expectEffects(dispatches, effectText);
    };
    const expectDifferentRuns = (a: string | undefined, b: string | undefined) =>
      expect.soft(Boolean(a && b && a !== b)).toBe(true);
    for (const order of [
      ["writer", "reader"],
      ["reader", "writer"],
    ] as const) {
      const callId = "shared-" + order.join("-");
      const before = attempts.length;
      await fs.rm(marker, { force: true });
      const first = await consult(order[0], callId);
      await finishAccepted(first);
      const second = await consult(order[1], callId);
      await finishAccepted(second);
      if (first.ok && second.ok) {
        expect(attempts[before]?.runId).toBe(first.payload?.runId);
        expect(attempts[before + 1]?.runId).toBe(second.payload?.runId);
      }
      expect.soft([first.ok, second.ok], order.join(" → ")).toEqual([true, true]);
      expect
        .soft(attempts.slice(before).map(({ caller, exec }) => ({ caller, exec })))
        .toEqual(order.map((caller) => ({ caller, exec: caller === "writer" })));
      expectDifferentRuns(first.payload?.runId, second.payload?.runId);
      expect.soft(await effects()).toBe("effect\n");
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
    const foreignControl = await steer(peers.reader);
    // A lower-grant socket of the same signed device may observe its existing
    // intent, but must not acquire the original connection's control custody.
    const narrowedActivePeer = await connect("writer", ["operator.read", "operator.talk"]);
    const narrowedActive = await consult("writer", "active-shared", narrowedActivePeer);
    const narrowedControl = await steer(narrowedActivePeer);
    const pendingOther = consult("reader", "active-shared");
    const ownControl = await steer(peers.writer);
    const effectsBeforeRelease = await effects();
    hold.release.resolve();
    hold = undefined;
    const other = await pendingOther;
    await firstFinished;
    await finishAccepted(other);
    await settled();
    expect
      .soft([retransmit.payload?.runId, narrowedActive.payload?.runId])
      .toEqual([first.payload?.runId, first.payload?.runId]);
    expectDifferentRuns(first.payload?.runId, other.payload?.runId);
    expect
      .soft([narrowedControl.ok, foreignControl.ok, ownControl.ok])
      .toEqual([false, false, true]);
    expect.soft(effectsBeforeRelease).toBe("");
    expect
      .soft(attempts.slice(beforeHeld).map(({ caller }) => caller))
      .toEqual(["writer", "reader"]);
    expect(await effects()).toBe("effect\n");
    // A new socket with the same signed identity/grants replays accepted work.
    const beforeReconnect = attempts.length;
    // Reordered, equivalent and narrowed grants all retain the signed caller's request identity.
    for (const scopes of [
      ["operator.approvals", "operator.talk", "operator.write", "operator.read"],
      ["operator.write", "operator.approvals"],
      ["operator.write"],
    ]) {
      await reconnectWriter(scopes);
      await expectCompletedReplay(
        await consult("writer", "active-shared"),
        beforeReconnect,
        "effect\n",
      );
      expect(approvals).toHaveLength(0);
    }
    expect(clients.get("writer")?.connect.scopes).not.toContain("operator.approvals");
    const beforeFresh = attempts.length;
    const fresh = await runFresh("genuinely-new-call");
    expect(fresh.payload?.runId).not.toBe(first.payload?.runId);
    await expectEffects(beforeFresh + 1, "effect\neffect\n");
    // Keep a separate, genuinely write-authorized observer solely for agent.wait.
    // The read-only action below is still admitted from its own signed socket.
    const runObserver = peers.writer;
    peers.writer = await connect("writer", ["operator.read", "operator.talk"]);
    const beforeReadOnly = attempts.length;
    const beforeReadOnlyEffects = await effects();
    const readOnlyRetry = await consult("writer", "active-shared");
    await expectCompletedReplay(readOnlyRetry, beforeReadOnly, beforeReadOnlyEffects);
    const readOnlyFresh = await runFresh("new-read-only-call", false, runObserver);
    expect(attempts.at(-1)).toMatchObject({
      caller: "writer",
      exec: false,
      runId: readOnlyFresh.payload?.runId,
    });
    await expectEffects(beforeReadOnly + 1, beforeReadOnlyEffects);
    await reconnectWriter(["operator.read"]);
    const deniedRetry = await consult("writer", "active-shared");
    const deniedFresh = await consult("writer", "new-without-talk");
    for (const result of [deniedRetry, deniedFresh]) {
      expect(result.ok).toBe(false);
      expect(result.error?.message).toContain("missing scope: operator.talk");
    }
    await expectEffects(beforeReadOnly + 1, beforeReadOnlyEffects);
    expect(clients.size).toBe(2);
    const writer = clients.get("writer");
    const reader = clients.get("reader");
    expect(writer?.connect.client.id).toBe(reader?.connect.client.id);
    expect(writer?.connect.device?.id).not.toBe(reader?.connect.device?.id);
    expect(writer?.authenticatedUserProfile?.profileId).toBe(
      reader?.authenticatedUserProfile?.profileId,
    );
    for (const client of [writer, reader]) {
      expect(client?.connect.scopes).not.toContain("operator.write");
    }
    expect(approvals).toHaveLength(0);
    // Legacy clients omit the logical voice ID. Retiring its inferred record
    // must not turn a retransmitted call into another native effect.
    await reconnectWriter();
    const beforeLegacy = attempts.length;
    await runFresh("legacy-retry", true);
    const originalLegacyVoice = legacyBinding();
    legacyVoiceForCleanup = originalLegacyVoice;
    const legacyEffects = await effects();
    await closeVoice(peers.writer, originalLegacyVoice);
    await reconnectWriter();
    const legacyRetry = await consult("writer", "legacy-retry", peers.writer, true);
    await finishAccepted(legacyRetry);
    const regeneratedLegacyVoice = legacyBinding();
    legacyVoiceForCleanup = regeneratedLegacyVoice;
    expect(regeneratedLegacyVoice).toBeTypeOf("string");
    expect(regeneratedLegacyVoice).not.toBe(originalLegacyVoice);
    expect(legacyRetry.ok).toBe(false);
    await expectEffects(beforeLegacy + 1, legacyEffects);
    await runFresh("legacy-new-call", true);
    await expectEffects(beforeLegacy + 2, `${legacyEffects}effect\n`);
  } finally {
    hold?.release.resolve();
    observeCaller.mockRestore();
    if (legacyVoiceForCleanup) {
      const writerSocket = sockets.at(-1);
      await closeVoice(expectDefined(writerSocket, "legacy cleanup socket"), legacyVoiceForCleanup);
    }
    for (const socket of sockets) {
      socket.close();
    }
    await settled();
  }
}

/** Uses the history suite's existing Gateway, transcript state, and model seam. */
export async function runTalkNativeActionParity(fixture: {
  context: GatewayRequestContext;
  client: GatewayClient;
  agentId: string;
  sessionKey: string;
  canonicalKey: string;
  sessionId: string;
  storePath: string;
  voiceSessionId: string | undefined;
  connectionId: string;
  runEmbeddedAgent: MockInstance<EmbeddedRun>;
  rpc: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  consult: (question: string, callId: string) => Promise<Record<string, unknown>>;
  waitForDispatchEnd: () => Promise<void>;
}) {
  const { context, client, agentId, sessionKey, runEmbeddedAgent, waitForDispatchEnd } = fixture;
  const { canonicalKey, sessionId: parentSessionId, storePath } = fixture;
  await prepareActionSession({ agentId, sessionKey: canonicalKey, storePath }, parentSessionId);
  const results: unknown[] = [];
  let marker: string | undefined;
  const resetWriteMarker = () =>
    fs.rm(
      path.join(path.dirname(expectDefined(marker, "native effect file")), "voice-parity-note.txt"),
      { force: true },
    );
  runEmbeddedAgent.mockImplementation(async (params) => {
    const { workspaceDir } = params;
    const { execution, host } = await openActionHost(params, "parity-test-model", agentId);
    const policy = projectEffectiveExecPolicy({
      base: { host: "gateway", mode: "full" },
      overrides: params.execOverrides,
      permissionPolicy: { mode: params.permissionMode ?? "read-only" },
    });
    marker = path.join(workspaceDir, "voice-parity-effects");
    const [tool, writeTool] = host.capabilities.bindToolSurface([
      createExecTool({
        ...policy,
        ...execution,
        cwd: workspaceDir,
        allowBackground: false,
      }),
      createHostWorkspaceWriteTool(workspaceDir),
    ]);
    try {
      const result = await expectDefined(tool, "bound native exec").execute("same-model-action", {
        command: "printf 'effect\n' >> voice-parity-effects",
        workdir: workspaceDir,
        yieldMs: 10000,
      });
      const written = await expectDefined(writeTool, "bound filesystem action").execute(
        "same-write-action",
        { path: "voice-parity-note.txt", content: "same permitted note" },
      );
      expect(written.content).toContainEqual(
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Successfully wrote"),
        }),
      );
      expect(await fs.readFile(path.join(workspaceDir, "voice-parity-note.txt"), "utf8")).toBe(
        "same permitted note",
      );
      results.push(result.details);
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
      return {
        payloads: [{ text: "Done." }],
        meta: { durationMs: 1, terminalReply: { disposition: "visible", text: "Done." } },
      };
    } finally {
      host.close();
    }
  });
  await fixture.rpc("chat.send", {
    sessionKey,
    message: "Carry out the action",
    idempotencyKey: "parity-text",
  });
  await waitForDispatchEnd();
  expect(results).toHaveLength(1);
  const retained = await retainTalkClientRunAuthority({ client, context });
  try {
    const runner = createTalkClientAgentConsultRunner({
      config: getRuntimeConfig(),
      context,
      sessionTarget: await prepareTalkSessionTarget(getRuntimeConfig(), sessionKey),
      ownerConnId: fixture.connectionId,
      runAuthority: retained,
      authority: resolveTalkAgentConsultAuthority(client.connect.scopes, client),
      getVoiceSessionId: () => fixture.voiceSessionId,
      initialItems: [],
    });
    await resetWriteMarker();
    expect(await runner.runArgs({ question: "Carry out the action" })).toEqual({ text: "Done." });
    expect(results).toHaveLength(2);
    await resetWriteMarker();
    await fixture.consult("Carry out the action", "parity-provider-call");
    await waitForDispatchEnd();
    expect(results).toHaveLength(3);
    expect(await fs.readFile(expectDefined(marker, "native effect file"), "utf8")).toBe(
      "effect\neffect\neffect\n",
    );
  } finally {
    retained.release();
  }
}
