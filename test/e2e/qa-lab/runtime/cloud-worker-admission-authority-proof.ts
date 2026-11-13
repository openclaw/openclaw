import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import {
  createQaBusState,
  createQaChannelTransport,
  createQaGatewayChild,
  QA_EVIDENCE_FILENAME,
  startQaBusServer,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import {
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
} from "../../../../src/infra/node-commands.js";
import type { NodeInvokeRequestPayload } from "../../../../src/node-host/invoke.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { MODEL_REF, PROOF_TIMEOUT_MS, waitFor } from "./cloud-worker-midturn-loss-fixture.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  wireMessageText,
  type PairedNodeWorkerHost,
  type PublishedWireWorkspace,
} from "./paired-node-worker-wire-fixture.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SCENARIO_ID = "cloud-worker-admission-authority";
const VERDICT_FILE = `${SCENARIO_ID}-verdict.json`;
// qa-channel per-peer routing for SENDER_ID; created first so inbound turns land in this worktree session.
const SESSION_KEY = "agent:qa:direct:dm:cloud-admission-authority";
const SENDER_ID = "cloud-admission-authority";
const BASELINE_MARKER = "AUTH-PROBE-BASELINE";

type ProducerOptions = { artifactBase: string; repoRoot: string };
type GatewayEvent = { event: string; payload?: unknown };
type RunResult = { runId?: string; status?: string; error?: unknown };
type LaunchHook = (frame: NodeInvokeRequestPayload) => Promise<void>;
const LAUNCH = NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND;
const CANCEL = NODE_WORKER_SUPERVISOR_CANCEL_COMMAND;

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function commandCount(frames: readonly NodeInvokeRequestPayload[], command: string) {
  return frames.filter((frame) => frame.command === command).length;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function parseOptions(argv: readonly string[]): ProducerOptions {
  const index = argv.indexOf("--artifact-base");
  const artifactBase = index >= 0 ? argv[index + 1] : undefined;
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return { artifactBase: path.resolve(artifactBase), repoRoot: process.cwd() };
}

function writeSse(response: ServerResponse, text: string, id: string) {
  const item = {
    type: "message",
    id,
    role: "assistant",
    phase: "final_answer",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
  send({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } });
  send({
    type: "response.output_text.delta",
    item_id: id,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
  send({ type: "response.output_item.done", output_index: 0, item });
  send({
    type: "response.completed",
    response: {
      id: `resp_${id}`,
      status: "completed",
      output: [item],
      usage: { input_tokens: 16, output_tokens: 4, total_tokens: 20 },
    },
  });
  response.end("data: [DONE]\n\n");
}

/** Mock OpenAI Responses provider; every request is retained so cases can count model I/O. */
async function startProbeProvider() {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push(raw);
      const markers = raw.match(/AUTH-PROBE-[A-Z0-9-]+/gu) ?? [];
      const marker = markers.at(-1) ?? BASELINE_MARKER;
      writeSse(response, `${marker}-OK`, `msg_${requests.length}`);
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("probe provider did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    countFor: (marker: string) => requests.filter((raw) => raw.includes(marker)).length,
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function runProof(options: ProducerOptions) {
  const state = createQaBusState();
  // openclaw-temp-dir: allow standalone QA producer owns and removes this fixture root.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cloud-admission-authority-"));
  const gatewayOwner = createQaGatewayChild();
  let bus: Awaited<ReturnType<typeof startQaBusServer>> | undefined;
  let provider: Awaited<ReturnType<typeof startProbeProvider>> | undefined;
  let operator: GatewayClient | undefined;
  let node: PairedNodeWorkerHost | undefined;
  let published: PublishedWireWorkspace | undefined;
  let onLaunch: LaunchHook | undefined;
  let proofError: unknown;
  let verdict: Record<string, unknown> | undefined;
  const events: GatewayEvent[] = [];
  try {
    bus = await startQaBusServer({ state });
    provider = await startProbeProvider();
    published = await createPublishedWireWorkspace(root);
    const gateway = await gatewayOwner.start({
      repoRoot: options.repoRoot,
      initializeCurrentRuntimeState: true,
      useRepoCli: true,
      providerBaseUrl: `${provider.baseUrl}/v1`,
      providerMode: "mock-openai",
      primaryModel: MODEL_REF,
      alternateModel: MODEL_REF,
      transport: createQaChannelTransport(state),
      transportBaseUrl: bus.baseUrl,
      enabledPluginIds: ["qa-lab"],
      controlUiEnabled: false,
      mutateConfig: (config) => ({
        ...config,
        session: { ...config.session, dmScope: "per-peer" },
        nodeHost: { ...config.nodeHost, workerRuns: { enabled: true } },
      }),
    });
    operator = await connectWireClient({
      gateway,
      role: "operator",
      identity: null,
      onEvent: (event) => events.push(event),
    });
    node = await createPairedNodeWorkerHost({
      gateway,
      operator,
      root,
      label: "authority-worker",
      beforeInvoke: async (frame) => {
        if (frame.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND) {
          await onLaunch?.(frame);
        }
      },
    });
    await operator.request("sessions.create", {
      key: SESSION_KEY,
      agentId: "qa",
      worktree: true,
      worktreeName: `cloud-authority-${randomUUID().slice(0, 8)}`,
      worktreeBaseRef: "main",
      cwd: published.source,
    });
    const baselineCursor = state.getSnapshot().messages.length;
    state.addInboundMessage({
      conversation: { id: SENDER_ID, kind: "direct" },
      senderId: SENDER_ID,
      senderName: SENDER_ID,
      text: `Reply exactly: ${BASELINE_MARKER}`,
    });
    await waitFor("local baseline reply", () =>
      state
        .getSnapshot()
        .messages.slice(baselineCursor)
        .some((message) => message.direction === "outbound" && message.text.includes("-OK"))
        ? true
        : undefined,
    );
    const deviceId = node.identity.deviceId;
    // Baseline follow-up work can keep the session busy briefly; dispatch refuses until it settles.
    await waitFor("worker dispatch", async () => {
      try {
        await gateway.call(
          "sessions.dispatch",
          { key: SESSION_KEY, deviceId },
          { timeoutMs: PROOF_TIMEOUT_MS },
        );
        return true;
      } catch (error) {
        if (String(error).includes("busy with active work")) {
          await delay(500);
          return undefined;
        }
        throw error;
      }
    });
    const workerNode = node;
    const client = operator;
    const history = async () =>
      (
        await client.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey: SESSION_KEY,
          limit: 200,
        })
      ).messages ?? [];
    const describePlacement = async () =>
      record(
        record(
          record(await gateway.call("sessions.describe", { key: SESSION_KEY }), "describe").session,
          "session",
        ).placement ?? {},
        "placement",
      );

    const waitTerminal = async (runId: string) => {
      // A follow-up queued behind an earlier lane reports pending until it starts.
      return await waitFor(`terminal ${runId}`, async () => {
        const waited = await client.request<RunResult>(
          "agent.wait",
          { runId, timeoutMs: PROOF_TIMEOUT_MS },
          { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
        );
        return waited.status === "pending" ? undefined : waited;
      });
    };

    /**
     * One turn through the real dispatch path. `chat` input is staged and admitted by the worker
     * admission RPC; `channel` input is persisted by reply admission before dispatch, so the
     * worker launcher receives an already-persisted recorder that carries its receipt.
     */
    const runCase = async (
      name: string,
      input: "chat" | "channel",
      revoke?: (runId: string) => Promise<void>,
    ) => {
      const marker = `AUTH-PROBE-${name.toUpperCase()}-${randomUUID().slice(0, 8).toUpperCase()}`;
      const framesBefore = workerNode.frames.length;
      const logMark = gateway.logs().length;
      const cursorsBefore = await describePlacement();
      const launches: Array<{ runId?: string; launchId?: string }> = [];
      let cancelledBeforeLaunchDelivered = false;
      let userInTranscriptAtLaunch: boolean | undefined;
      onLaunch = async (frame) => {
        const params = JSON.parse(frame.paramsJSON ?? "{}") as { launchId?: string };
        const runId = /"runId":"([^"]+)"/u.exec(frame.paramsJSON ?? "")?.[1];
        launches.push({ runId, launchId: params.launchId });
        // Shows which admission path the launcher took: already-persisted input carries its
        // receipt into the launch; staged input is committed later by the worker admission RPC.
        userInTranscriptAtLaunch = (await history()).some((message) =>
          wireMessageText(message).includes(marker),
        );
        if (!revoke || !runId) {
          return;
        }
        // The launch frame is on the node but not yet handled: revoke authority, wait for the
        // Gateway's own cancel, then hand the stale launch to the real node handler.
        const cancelsBefore = commandCount(workerNode.frames.slice(framesBefore), CANCEL);
        await revoke(runId);
        await waitFor("Gateway worker cancel", () =>
          commandCount(workerNode.frames.slice(framesBefore), CANCEL) > cancelsBefore
            ? true
            : undefined,
        );
        cancelledBeforeLaunchDelivered = true;
      };
      let runId: string;
      if (input === "chat") {
        runId = `cloud-authority-${name}-${randomUUID()}`;
        const started = await client.request<RunResult>("chat.send", {
          sessionKey: SESSION_KEY,
          message: `Reply exactly: ${marker}`,
          deliver: false,
          idempotencyKey: runId,
        });
        assert.equal(started.status, "started");
      } else {
        state.addInboundMessage({
          conversation: { id: SENDER_ID, kind: "direct" },
          senderId: SENDER_ID,
          senderName: SENDER_ID,
          text: `Reply exactly: ${marker}`,
        });
        const deadline = Date.now() + 60_000;
        while (!launches[0]?.runId && Date.now() < deadline) {
          await delay(100);
        }
        if (!launches[0]?.runId) {
          const outbound = state
            .getSnapshot()
            .messages.filter((message) => message.direction === "outbound")
            .map((message) => message.text.slice(0, 100));
          throw new Error(
            `channel turn did not launch: outbound=${JSON.stringify(outbound)} log=${gateway.logs().slice(logMark).slice(-4000)}`,
          );
        }
        runId = launches[0].runId;
      }
      const waited = await waitTerminal(runId);
      // Join the held launch and its real node handling before reading node facts.
      await workerNode.waitForInvokes();
      await workerNode.waitForWorkersIdle();
      onLaunch = undefined;
      const receipts = await Promise.all(
        launches.map(async ({ launchId }) => {
          const receipt = launchId ? await workerNode.supervisor.status(launchId) : undefined;
          return receipt
            ? { state: receipt.state, workerProcessStarted: Boolean(receipt.worker) }
            : { state: "none", workerProcessStarted: false };
        }),
      );
      const runMessages = (await history()).filter((message) =>
        wireMessageText(message).includes(marker),
      );
      const after = await describePlacement();
      return {
        input,
        runId,
        waitStatus: waited.status,
        nodeFrames: Object.fromEntries(
          [LAUNCH, CANCEL, "worker.status.v1", "worker.workspace.exec.v1"].map((command) => [
            command,
            commandCount(workerNode.frames.slice(framesBefore), command),
          ]),
        ),
        launchesForRun: launches.filter((launch) => launch.runId === runId).length,
        cancelledBeforeLaunchDelivered,
        userInTranscriptAtLaunch,
        supervisorReceipts: receipts,
        modelRequests: provider?.countFor(marker) ?? -1,
        transcript: runMessages.map((message) => ({
          role: record(message, "message").role,
          text: wireMessageText(message).slice(0, 80),
        })),
        placement: {
          state: after.state,
          transcriptAckCursor: [
            cursorsBefore.lastTranscriptAckCursor,
            after.lastTranscriptAckCursor,
          ],
          liveEventAckCursor: [cursorsBefore.lastLiveEventAckCursor, after.lastLiveEventAckCursor],
        },
        gatewayLog: gateway
          .logs()
          .slice(logMark)
          .split("\n")
          .filter((line) => /chat\.abort|reclaim|Cloud worker|worker launch|admission/iu.test(line))
          .map((line) => line.replace(/ conn=\S+| ip=\S+| device=\S+/gu, "").slice(0, 300))
          .slice(-8),
      };
    };

    const validStaged = await runCase("staged", "chat");
    const validChannel = await runCase("channel", "channel");
    const runCancelled = await runCase("runcancel", "chat", async (runId) => {
      await client.request("chat.abort", { sessionKey: SESSION_KEY, runId });
    });
    let reclaim: Promise<unknown> | undefined;
    const placementReclaimed = await runCase("reclaim", "chat", async () => {
      // Reclaim closes the turn claim first; its response waits for this turn to settle.
      reclaim = client.request("sessions.reclaim", { key: SESSION_KEY });
    });
    const reclaimed = record(await reclaim, "sessions.reclaim");
    assert.equal(validStaged.userInTranscriptAtLaunch, false);
    for (const valid of [validStaged, validChannel]) {
      assert.equal(valid.waitStatus, "ok");
      assert.equal(valid.launchesForRun, 1);
      assert.equal(valid.modelRequests, 1);
      assert.deepEqual(
        valid.transcript.map((entry) => entry.role),
        ["user", "assistant"],
      );
    }
    for (const revoked of [runCancelled, placementReclaimed]) {
      assert.notEqual(revoked.waitStatus, "ok");
      assert.ok(revoked.cancelledBeforeLaunchDelivered, JSON.stringify(revoked));
      assert.ok(
        revoked.supervisorReceipts.every((receipt) => !receipt.workerProcessStarted),
        "revoked launch must not start a worker process",
      );
      assert.equal(revoked.modelRequests, 0, "revoked turn must not reach the model");
      assert.ok(
        revoked.transcript.every((entry) => entry.role === "user"),
        "revoked turn must not commit worker output",
      );
      assert.equal(
        revoked.placement.transcriptAckCursor[0],
        revoked.placement.transcriptAckCursor[1],
      );
    }
    verdict = {
      status: "pass",
      protocolMode: "worker-turn-admission-v1",
      validStaged,
      validChannel,
      runCancelled,
      placementReclaimed: {
        ...placementReclaimed,
        reclaimState: record(reclaimed.placement, "reclaimed placement").state,
      },
    };
    await fs.mkdir(options.artifactBase, { recursive: true });
    await fs.writeFile(
      path.join(options.artifactBase, VERDICT_FILE),
      `${JSON.stringify(verdict, null, 2)}\n`,
      "utf8",
    );
  } catch (error) {
    proofError = error;
  } finally {
    const cleanup = await Promise.allSettled([
      operator?.stopAndWait({ timeoutMs: 1_000 }) ?? Promise.resolve(),
      node?.stop() ?? Promise.resolve(),
      stopQaGatewayFixture(gatewayOwner),
      published ? closeWireServer(published.server) : Promise.resolve(),
      provider?.stop() ?? Promise.resolve(),
      bus?.stop() ?? Promise.resolve(),
      fs.rm(root, { recursive: true, force: true }),
    ]);
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      proofError = new AggregateError(
        proofError ? [proofError, ...failures] : failures,
        "cloud worker admission authority cleanup failed",
      );
    }
  }
  if (proofError) {
    throw toErrorObject(proofError, "Cloud worker admission authority proof failed");
  }
  if (!verdict) {
    throw new Error("cloud worker admission authority proof produced no verdict");
  }
  return verdict;
}

async function runProducer(options: ProducerOptions): Promise<QaEvidenceSummaryJson> {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: MODEL_REF,
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Cloud worker admission and authority before worker I/O",
      sourcePath: `qa/scenarios/runtime/${SCENARIO_ID}.yaml`,
      docsRefs: ["docs/gateway/cloud-workers/session-lifecycle.md"],
      codeRefs: [
        "src/gateway/worker-environments/worker-turn-execution.ts",
        "src/gateway/worker-environments/worker-turn-user-message.ts",
      ],
    },
  });
  const startedAt = Date.now();
  try {
    const verdict = await runProof(options);
    writer.appendLog(`pass: ${JSON.stringify(verdict)}\n`);
    return await writer.write({
      artifacts: [{ filePath: VERDICT_FILE, kind: "verdict" }],
      details: "worker turn authority verdict",
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    writer.appendLog(`fail: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  }
}

async function main(argv: readonly string[]) {
  const options = parseOptions(argv);
  const evidence = await runProducer(options);
  const status = evidence.entries[0]?.result.status;
  console.log(`Cloud worker admission authority evidence: ${QA_EVIDENCE_FILENAME}`);
  if (status === "pass") {
    console.log((await fs.readFile(path.join(options.artifactBase, VERDICT_FILE), "utf8")).trim());
  } else {
    console.log(evidence.entries[0]?.result.failure?.reason);
  }
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
