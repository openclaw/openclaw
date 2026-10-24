import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerLiveEventParams } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInferenceStartParams } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runWorkerProviderReplayRoundTrip } from "../../test/helpers/worker-provider-replay-roundtrip.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { loadWorkspaceSkills } from "../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../skills/loading/workspace-skill-prompt.js";
import { prepareSkillResourceDelivery } from "../skills/runtime/resources.js";
import { runWorkerCommand } from "./worker-command.runtime.js";
import {
  WorkerAdmissionError,
  WorkerConnectionStoppedError,
} from "./worker-connection-contract.js";
import {
  ComposedGatewayHarness,
  ENVIRONMENT_ID,
  RUN_ID,
  SESSION_ID,
  doneMessage,
  doneOutcome,
  type WorkerClients,
} from "./worker-fault-injection.test-support.js";
import { runWorkerDescriptor } from "./worker.runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const REPLACEMENT_CREDENTIAL = ["worker", "replacement", "fixture"].join("-");
const MODEL_REF = { provider: "fake", model: "fault-model" } as const;
const TERMINAL_EVENT = {
  kind: "lifecycle" as const,
  payload: { phase: "finishing" as const, startedAt: 1, endedAt: 2 },
};

function transcriptMessage(text: string) {
  return {
    role: "user" as const,
    content: [{ type: "text" as const, text }],
    timestamp: 1,
  };
}

function inferenceRequest(epoch: number, turnId: string): WorkerInferenceStartParams {
  return {
    runEpoch: epoch,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    turnId,
    modelRef: MODEL_REF,
    context: { messages: [] },
    options: {},
  };
}

function waitForWorkerEvent(
  event: Promise<void>,
  command: Promise<unknown>,
  phase: string,
  resultOutput?: Promise<void>,
): Promise<void> {
  const completed = resultOutput ? Promise.race([command, resultOutput]) : command;
  return awaitGateBeforeSettlement(event, completed, `Worker completed before ${phase}`);
}

describe("cloud worker milestone 2 fault injection", () => {
  let harness: ComposedGatewayHarness;
  const clients: WorkerClients[] = [];

  beforeEach(async () => {
    harness = await ComposedGatewayHarness.create(tempDirs.make("oc-wf-"));
    await harness.start();
  });

  afterEach(async () => {
    for (const current of clients.splice(0)) {
      current.inference.dispose();
      current.live.dispose();
      await current.connection.stop();
    }
    await harness.close();
  });

  async function createClients(options?: Parameters<ComposedGatewayHarness["createClients"]>[0]) {
    const current = await harness.createClients(options);
    clients.push(current);
    return current;
  }

  function transcriptGate(phase: NonNullable<ComposedGatewayHarness["transcriptGate"]>["phase"]) {
    const gate = { phase, entered: createDeferred(), release: createDeferred() };
    harness.transcriptGate = gate;
    return gate;
  }

  const transcript = () => SessionManager.open(harness.sessionTarget);
  const placement = () => harness.placementStore.get(SESSION_ID);
  const pendingResults = () => harness.placementStore.listPendingWorkspaceResultsAsync();
  const liveRequests = () => harness.requestParams("worker.live-event") as WorkerLiveEventParams[];
  const previews = (client: WorkerClients, runId: string, ...deltas: string[]) => {
    for (const delta of deltas) {
      client.live.enqueuePreview(runId, { kind: "assistant", payload: { text: delta, delta } });
    }
  };

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0).each([
    ["success", "standalone", "skill", "completed", "stop"],
    ["success", "managed", "skill", "completed", "stop"],
    ["provider failure", "managed", "skill", "failed", "error"],
    ["cancellation", "managed", "skill", "failed", "aborted"],
    ["success", "standalone", "credential", "completed", "stop"],
    ["success", "managed", "credential", "completed", "stop"],
  ] as const)(
    "settles %s through the %s command with real permission failures deleting %s files",
    async (outcome, mode, deniedOwner, expectedStatus, stopReason) => {
      const skillDir = path.join(harness.root, "skills", "cleanup");
      await fs.mkdir(skillDir, { recursive: true });
      const markdown = "---\nname: cleanup\ndescription: Cleanup proof\n---\n# Instructions\n";
      await fs.writeFile(path.join(skillDir, "SKILL.md"), markdown);
      const descriptor = await harness.createDescriptor();
      descriptor.assignment.github = {
        login: "worker-cleanup-fixture",
        token: "synthetic-worker-cleanup-token",
        branch: "openclaw/cleanup-fixture",
      };
      const skillsSnapshot = await buildSkillSnapshot(harness.root, {
        entries: loadWorkspaceSkills(harness.root, { workspaceOnly: true }),
      });
      descriptor.assignment.systemPrompt = skillsSnapshot.prompt;
      descriptor.assignment.skillResources = await prepareSkillResourceDelivery(
        skillsSnapshot,
        () => {},
      );
      const previousStateDir = process.env.OPENCLAW_STATE_DIR;
      let environmentStateDir: string | undefined;
      const { release: providerRelease, started: providerStarted } = harness.planPending();
      const finishingGate = harness.addLiveEventGate("after-service", "finishing");
      const controller = new AbortController();
      const warn = vi.fn();
      const previousConsole = loggingState.rawConsole;
      setLoggerOverride({ level: "silent", consoleLevel: "warn" });
      loggingState.rawConsole = { log: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
      const input = new PassThrough();
      const output = new PassThrough();
      const resultOutput = createDeferred();
      let stdout = "";
      output.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.includes("\n")) {
          resultOutput.resolve();
        }
      });
      const lifetime = {
        signal: controller.signal,
        started: Promise.resolve(true),
        dispose: vi.fn(),
        reportConnectionFailure: vi.fn(),
        terminateOwnedTree: vi.fn(),
      };
      const managed = mode === "managed";
      const command = runWorkerCommand({ input, output, managed, lifetime });
      void command.catch(() => undefined);
      if (managed) {
        input.write(
          `${JSON.stringify({ type: "turn", turnId: descriptor.assignment.turnId, descriptor })}\n`,
        );
      } else {
        input.end(JSON.stringify(descriptor));
      }
      let protectedDirectory: string | undefined;
      let turnDirectory: string | undefined;
      try {
        await waitForWorkerEvent(
          providerStarted.promise,
          command,
          "provider start",
          resultOutput.promise,
        );
        environmentStateDir = process.env.OPENCLAW_STATE_DIR;
        expect(environmentStateDir).toBeDefined();
        expect(environmentStateDir).not.toBe(previousStateDir);
        const request = harness.requestParams(
          "worker.inference.start",
        )[0] as WorkerInferenceStartParams;
        const retainedFile = request.context.systemPrompt?.match(
          /<location>([^<]+)<\/location>/u,
        )?.[1];
        expect(retainedFile).toBeDefined();
        turnDirectory = path.dirname(path.dirname(retainedFile!));
        const profilesRoot = path.join(environmentStateDir!, "github-profiles");
        const profiles = await fs.readdir(profilesRoot);
        expect(profiles).toHaveLength(1);
        const profileDir = path.join(profilesRoot, profiles[0]!);
        const hostsPath = path.join(profileDir, "hosts.yml");
        expect(await fs.readFile(hostsPath, "utf8")).toContain(descriptor.assignment.github.token);
        protectedDirectory = deniedOwner === "skill" ? path.dirname(retainedFile!) : profileDir;
        expect(await fs.readFile(retainedFile!, "utf8")).toBe(markdown);
        await fs.chmod(protectedDirectory, 0o500);
        if (outcome === "cancellation") {
          input.write(
            `${JSON.stringify({ type: "cancel", turnId: descriptor.assignment.turnId })}\n`,
          );
        } else {
          providerRelease.resolve(
            outcome === "provider failure"
              ? { type: "error", reason: "provider-error", message: "fixture provider failed" }
              : doneOutcome("paid reply"),
          );
        }
        await waitForWorkerEvent(
          finishingGate.entered.promise,
          command,
          "finishing event",
          resultOutput.promise,
        );
        if (outcome === "cancellation") {
          expect(harness.requestParams("worker.inference.cancel")).toHaveLength(1);
        }
        const finishing = liveRequests().filter(
          ({ event }) => event.kind === "lifecycle" && event.payload.phase === "finishing",
        );
        expect(finishing).toHaveLength(1);
        expect(finishing[0]?.event).toMatchObject({
          kind: "lifecycle",
          payload: {
            phase: "finishing",
            stopReason,
            ...(outcome === "cancellation" ? { aborted: true } : {}),
          },
        });
        const payload = finishing[0]!.event.payload;
        if (outcome === "success") {
          expect(payload).not.toHaveProperty("error");
        } else {
          expect(payload).toHaveProperty(
            "error",
            outcome === "provider failure" ? "fixture provider failed" : "worker turn cancelled",
          );
        }
        expect(await pendingResults()).toMatchObject([
          { sessionId: SESSION_ID, environmentId: ENVIRONMENT_ID, runId: RUN_ID },
        ]);
        expect(placement()?.lastLiveEventAckCursor).toBe(finishing[0]!.seq);
        finishingGate.release.resolve();
        if (deniedOwner === "credential") {
          // Bun reports the containing directory's ENOTEMPTY until oven-sh/bun#42446 lands.
          await expect.soft(command).rejects.toMatchObject({
            code: process.versions.bun
              ? expect.stringMatching(/^(?:EACCES|ENOTEMPTY)$/u)
              : "EACCES",
          });
        } else {
          await expect.soft(command).resolves.toBeUndefined();
        }
        const settled: unknown = JSON.parse(stdout || "null");
        const session = transcript();
        const messages = session
          .getEntries()
          .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
        const assistant = {
          role: "assistant",
          stopReason,
          ...(outcome === "success"
            ? { content: [{ type: "text", text: "paid reply" }] }
            : { errorMessage: "fixture provider failed" }),
        };
        expect(messages).toMatchObject(
          outcome === "cancellation" ? [{ role: "user" }] : [{ role: "user" }, assistant],
        );
        const expectedResult = { status: expectedStatus, transcriptLeafId: session.getLeafId() };
        if (deniedOwner === "credential" && !managed) {
          expect.soft(stdout).toBe("");
        } else {
          expect.soft(settled).toMatchObject(
            managed
              ? {
                  type: "result",
                  turnId: descriptor.assignment.turnId,
                  retainWorker: false,
                  result: expectedResult,
                }
              : expectedResult,
          );
        }
        expect(lifetime.dispose).toHaveBeenCalledOnce();
        expect(lifetime.terminateOwnedTree).not.toHaveBeenCalled();
        expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
        expect(harness.providerCalls).toBe(1);
        expect(harness.requestParams("worker.inference.start")).toHaveLength(1);
        expect(harness.requestParams("worker.live-event")).toHaveLength(finishing[0]!.seq);
        const warning = warn.mock.calls.flat().map(String).join("\n");
        if (deniedOwner === "skill") {
          expect(await fs.readFile(retainedFile!, "utf8")).toBe(markdown);
          await expect
            .soft(fs.stat(environmentStateDir!))
            .rejects.toMatchObject({ code: "ENOENT" });
          await expect.soft(fs.stat(hostsPath)).rejects.toMatchObject({ code: "ENOENT" });
          expect.soft(warning).toContain("Materialized skill cleanup failed");
          expect.soft(warning).toContain(turnDirectory);
          expect.soft(warning).toMatch(process.versions.bun ? /EACCES|ENOTEMPTY/u : /EACCES/u);
        } else {
          expect(await fs.readFile(hostsPath, "utf8")).toContain(
            descriptor.assignment.github.token,
          );
          await expect(fs.stat(turnDirectory)).rejects.toMatchObject({ code: "ENOENT" });
        }
        expect.soft(warning).not.toContain("Worker environment cleanup failed");
        expect.soft(warning).not.toContain(descriptor.assignment.github.token);
        expect.soft(warning).not.toContain(markdown);
      } finally {
        providerRelease.resolve(doneOutcome("fixture teardown"));
        finishingGate.release.resolve();
        controller.abort(new Error("fixture teardown"));
        input.end();
        await Promise.allSettled([command]);
        try {
          // Keep deletion blocked until the command's enclosing teardown has settled.
          if (protectedDirectory) {
            await fs.chmod(protectedDirectory, 0o700);
          }
          if (turnDirectory) {
            await fs.rm(turnDirectory, { recursive: true, force: true });
          }
          if (environmentStateDir) {
            await fs.rm(environmentStateDir, { recursive: true, force: true });
          }
        } finally {
          output.destroy();
          loggingState.rawConsole = previousConsole;
          setLoggerOverride(null);
          resetLogger();
        }
      }
    },
  );

  it("replays captured compaction exactly after worker commit and canonical reopen", async () => {
    await runWorkerProviderReplayRoundTrip({
      createDescriptor: (options) => harness.createDescriptor(options),
      requestParams: (method) => harness.requestParams(method),
      sessionTarget: harness.sessionTarget,
      settleRun: (runId) => harness.settleRun(runId),
      setOutcome: (outcome) => {
        harness.providerPlan = { kind: "immediate", text: "roundtrip", outcome };
      },
    });
  });

  it.each(["before-service", "after-service"] as const)(
    "does not pace provider preview production on a delayed first request %s",
    async (previewStage) => {
      const nextProviderDelta = createDeferred();
      const providerProduced = createDeferred();
      const previewGate = harness.addLiveEventGate(previewStage, "preview");
      const finishingGate = harness.addLiveEventGate("after-service", "finishing");
      harness.providerPlan = {
        kind: "live-preview",
        nextRelease: nextProviderDelta,
        produced: providerProduced,
        text: "preview reply",
      };
      let settled = false;
      const controller = new AbortController();
      const result = runWorkerDescriptor(await harness.createDescriptor(), {
        signal: controller.signal,
      }).finally(() => {
        settled = true;
      });
      void result.catch(() => undefined);

      try {
        await waitForWorkerEvent(previewGate.entered.promise, result, "preview event");
        nextProviderDelta.resolve();
        await waitForWorkerEvent(providerProduced.promise, result, "provider completion");
        await waitForWorkerEvent(
          vi.waitFor(() =>
            expect(
              liveRequests().filter(
                ({ event }) => event.kind === "assistant" || event.kind === "thinking",
              ),
            ).toHaveLength(2),
          ),
          result,
          "both preview requests",
        );
        expect(settled).toBe(false);
        expect(placement()?.lastLiveEventAckCursor).toBeNull();

        previewGate.release.resolve();
        await waitForWorkerEvent(finishingGate.entered.promise, result, "finishing event");
        expect(settled).toBe(false);
        expect(transcript().getEntries()).toHaveLength(2);
        expect(placement()?.lastLiveEventAckCursor).toBeGreaterThan(0);
        expect(await pendingResults()).toMatchObject([
          { sessionId: SESSION_ID, environmentId: ENVIRONMENT_ID, runId: RUN_ID },
        ]);

        finishingGate.release.resolve();
        await expect(result).resolves.toMatchObject({
          transcriptLeafId: expect.any(String),
          transcriptNextSeq: expect.any(Number),
        });
      } finally {
        nextProviderDelta.resolve();
        previewGate.release.resolve();
        finishingGate.release.resolve();
        controller.abort(new Error("fixture teardown"));
        await Promise.allSettled([result]);
      }
    },
  );

  it("survives repeated tunnel partitions without transcript duplication, live replay, or rebilling", async () => {
    const current = await createClients();
    const firstRelease = createDeferred();
    const secondRelease = createDeferred();
    const started = createDeferred();
    harness.providerPlan = {
      kind: "partitioned",
      firstRelease,
      secondRelease,
      started,
      text: "partitioned reply",
    };
    harness.addFault({ kind: "partition-after-inference-event", seq: 1 });
    harness.addFault({ kind: "partition-after-inference-event", seq: 2 });
    harness.addFault({ kind: "drop-response", method: "worker.transcript.commit", restart: false });
    harness.addFault({ kind: "drop-response", method: "worker.live-event", restart: false });
    await current.start();

    const inferenceSeqs: number[] = [];
    const inference = current.inference.start(inferenceRequest(harness.epoch, "partitioned-turn"), {
      onEvent: (event) => inferenceSeqs.push(event.seq),
    });
    await started.promise;
    await vi.waitFor(() => expect(harness.requestParams("worker.inference.start")).toHaveLength(2));
    firstRelease.resolve();
    await vi.waitFor(() => expect(harness.requestParams("worker.inference.start")).toHaveLength(3));
    secondRelease.resolve();
    await expect(inference).resolves.toEqual(doneOutcome("partitioned reply"));

    const committed = await current.transcript.commit([
      transcriptMessage("partitioned user"),
      { ...doneMessage("partitioned reply"), timestamp: 2 },
    ]);
    expect(current.transcript).toMatchObject({ baseLeafId: committed.newLeafId, nextSeq: 2 });
    previews(current, RUN_ID, "one", "two", "three");
    await expect(current.live.emitTerminal(RUN_ID, TERMINAL_EVENT)).resolves.toBeUndefined();

    const transcriptRequests = harness.requestParams("worker.transcript.commit");
    expect(transcriptRequests).toHaveLength(2);
    expect(transcriptRequests[1]).toEqual(transcriptRequests[0]);
    expect(harness.requestParams("worker.inference.start")).toHaveLength(3);
    expect(harness.providerCalls).toBe(1);
    expect(inferenceSeqs).toEqual([1, 2]);
    expect(harness.liveDeltas).toEqual(["one", "two", "three"]);
    expect(liveRequests().map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 1, 2, 3, 4]);
    const entries = transcript().getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ message: transcriptMessage("partitioned user") });
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
    expect(transcript().getLeafId()).toBe(committed.newLeafId);
  });

  it("fences restart-inherited authority and recovers durable state on a fresh claim", async () => {
    const current = await createClients();
    const { release: providerRelease, started: providerStarted } = harness.planPending();
    const { entered: commitEntered, release: commitRelease } = transcriptGate("after-apply");
    harness.addFault({ kind: "drop-response", method: "worker.transcript.commit", restart: true });
    await current.start();

    previews(current, RUN_ID, "acked");
    await vi.waitFor(() => expect(harness.liveDeltas).toEqual(["acked"]));
    const inference = current.inference.start(inferenceRequest(harness.epoch, "restart-turn"));
    await providerStarted.promise;
    const commit = current.transcript.commit([transcriptMessage("restart transcript")]);
    const invalidHandshake = { name: "WorkerAdmissionError", reason: "invalid-handshake" };
    const fencedCommit = expect(commit).rejects.toMatchObject(invalidHandshake);
    const fencedInference = expect(inference).rejects.toMatchObject(invalidHandshake);
    await commitEntered.promise;
    previews(current, RUN_ID, "tail-a", "tail-b");
    // Admit the stale tail before restart to prove recovery fences it.
    await vi.waitFor(() =>
      expect(harness.requestParams("worker.live-event").length).toBeGreaterThanOrEqual(3),
    );
    commitRelease.resolve();

    await fencedCommit;
    await fencedInference;
    await expect(current.connection.waitForExit()).resolves.toMatchObject({
      kind: "failed",
      error: expect.objectContaining({
        name: WorkerAdmissionError.name,
        reason: "invalid-handshake",
      }),
    });
    expect(harness).toMatchObject({ providerCalls: 1, replacementProviderCalls: 0 });
    const staleIdentity = harness.admissions.at(-1);
    expect(staleIdentity).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      ownerEpoch: harness.epoch,
      sessionId: SESSION_ID,
      turnClaim: {
        runId: RUN_ID,
        owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: harness.epoch },
      },
    });
    expect(transcript().getEntries()).toHaveLength(1);

    const recoveryRunId = "restart-recovery-run";
    const oldEpoch = harness.epoch;
    const freshEpoch = await harness.reclaimWithCredential(REPLACEMENT_CREDENTIAL, recoveryRunId);
    expect(freshEpoch).toBeGreaterThan(oldEpoch);
    providerRelease.resolve(doneOutcome("late stale provider result"));
    const fresh = await createClients({
      admissionProof: REPLACEMENT_CREDENTIAL,
      epoch: freshEpoch,
      runId: recoveryRunId,
    });
    await fresh.start();
    previews(fresh, recoveryRunId, "recovered");
    await expect(fresh.live.emitTerminal(recoveryRunId, TERMINAL_EVENT)).resolves.toBeUndefined();
    const freshIdentity = harness.admissions.at(-1);
    expect(freshIdentity?.turnClaim).toMatchObject({
      runId: recoveryRunId,
      owner: { kind: "worker", environmentId: ENVIRONMENT_ID, ownerEpoch: freshEpoch },
    });
    expect(freshIdentity?.turnClaim?.claimId).not.toBe(staleIdentity?.turnClaim?.claimId);
    expect(harness.liveDeltas[0]).toBe("acked");
    expect(harness.liveDeltas.filter((delta) => delta === "recovered")).toEqual(["recovered"]);
    expect(
      liveRequests().map(({ runId, seq, lastAckedSeq }) => [runId, seq, lastAckedSeq]),
    ).toContainEqual([recoveryRunId, 1, 0]);
    await harness.settleRun(recoveryRunId);
  });

  it("fail-stops a reconnected commit whose base changes while application is in flight", async () => {
    const current = await createClients();
    const { entered, release } = transcriptGate("before-apply");
    await current.start();
    const commit = current.transcript.commit([transcriptMessage("stale paid output")]);
    await entered.promise;
    harness.partition();
    const local = transcript();
    local.appendMessage(transcriptMessage("competing local entry"));
    release.resolve();

    await expect(commit).rejects.toMatchObject({
      name: "WorkerTranscriptCommitError",
      reason: "stale-base-leaf",
    });
    expect(current.transcript).toMatchObject({ baseLeafId: null, nextSeq: 2 });
    await expect(
      current.transcript.commit([transcriptMessage("must not retry after stale")]),
    ).rejects.toMatchObject({ name: "WorkerTranscriptCommitError" });
    expect(current.transcript.nextSeq).toBe(2);
    expect(harness.requestParams("worker.transcript.commit")).toHaveLength(2);
    expect(transcript().getEntries()).toHaveLength(1);
  });

  it("settles stop during an in-flight commit without retrying or spinning", async () => {
    const current = await createClients();
    const { entered, release } = transcriptGate("before-apply");
    await current.start();
    const commit = current.transcript.commit([transcriptMessage("stopped commit")]);
    await entered.promise;

    await current.connection.stop();
    await expect(commit).rejects.toBeInstanceOf(WorkerConnectionStoppedError);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(harness.requestParams("worker.transcript.commit")).toHaveLength(1);
    release.resolve();
  });
});
