import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { startSessionDeliveryRuntime } from "../../infra/session-delivery-queue-runtime.js";
import { loadPendingSessionDeliveries } from "../../infra/session-delivery-queue-storage.js";
import { SessionDeliveryDeadLetteredError } from "../../infra/session-delivery-queue.records.js";
import { enqueueCommandInLane, getCommandLaneSnapshot } from "../../process/command-queue.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { getTaskById } from "../../tasks/runtime-internal.js";
import {
  resetDetachedTaskLifecycleRuntimeForTests,
  resetGeneratedMediaTaskActivityForTests,
  resetTaskRegistryForTests,
} from "../../tasks/task-runtime.test-helpers.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  createMediaGenerationTaskStatusOwner,
  MEDIA_GENERATION_QUEUED_COMPLETION_PROGRESS,
} from "../media-generation-task-status-shared.js";
import { resetRecentMediaGenerationDuplicateGuardsForTests } from "../media-generation-task-status-shared.test-support.js";
import {
  createMediaGenerationTaskLifecycle,
  scheduleMediaGenerationTaskCompletion,
  type MediaGenerationTaskHandle,
} from "./media-generate-background-shared.js";
import { runMediaGenerationTask } from "./media-generate-background.js";

it.each([
  ["image", false],
  ["image", true],
  ["music", false],
  ["music", true],
  ["video", false],
  ["video", true],
] as const)(
  "runs inline without a delivery runtime (%s, generation fails: %s)",
  async (kind, generationFails) => {
    await withTestDir({ prefix: "openclaw-media-inline-" }, async (tempDir) => {
      await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
        resetDetachedTaskLifecycleRuntimeForTests();
        resetGeneratedMediaTaskActivityForTests();
        resetTaskRegistryForTests({ persist: false });
        setRuntimeConfigSnapshot({ agents: { ownership: "explicit", entries: { main: {} } } });
        const queueContext = captureOpenClawStateWorkerContext();
        const lifecycle = createMediaGenerationTaskLifecycle({
          toolName: `${kind}_generate`,
          taskKind: `${kind}_generation`,
          label: `${kind} generation`,
          queuedProgressSummary: `Queued ${kind} generation`,
          generatedLabel: kind,
          failureProgressSummary: `${kind} generation failed`,
          eventSource: `${kind}_generation`,
          announceType: `${kind} generation task`,
          completionLabel: kind,
        });
        const handles: MediaGenerationTaskHandle[] = [];
        const generationError = new Error("synthetic inline generation failure");
        try {
          const result = runMediaGenerationTask({
            lifecycle: {
              ...lifecycle,
              createTaskRun: (params) => {
                const handle = lifecycle.createTaskRun(params);
                if (handle) {
                  handles.push(handle);
                }
                return handle;
              },
            },
            generationLabel: kind,
            sessionKey: "agent:main:inline-media",
            requesterAgentId: "main",
            prompt: "inline proof",
            requestKey: "inline-proof",
            scheduleBackgroundWork: () => {
              throw new Error("unexpected detached admission without a delivery runtime");
            },
            onFailure: () => {
              throw new Error("unexpected detached completion callback");
            },
            run: async () => {
              if (generationFails) {
                throw generationError;
              }
              return {
                provider: "fixture",
                model: "local",
                count: 1,
                wakeResult: "ready",
                contentText: "inline media result",
                details: { completedInline: true },
              };
            },
          });
          if (generationFails) {
            await expect(result).rejects.toBe(generationError);
          } else {
            await expect(result).resolves.toMatchObject({
              content: [{ type: "text", text: "inline media result" }],
              details: { completedInline: true },
            });
          }
          const handle = handles[0];
          if (!handle) {
            throw new Error("expected an admitted media task");
          }
          expect(getTaskById(handle.taskId)).toMatchObject({
            status: generationFails ? "failed" : "succeeded",
          });
          expect(await loadPendingSessionDeliveries(queueContext)).toHaveLength(0);
        } finally {
          await closeOpenClawStateDatabaseAsync();
          resetTaskRegistryForTests({ persist: false });
          resetGeneratedMediaTaskActivityForTests();
          resetDetachedTaskLifecycleRuntimeForTests();
          clearRuntimeConfigSnapshot();
        }
      });
    });
  },
);

// Exercise the real media waiter, SQLite queue, task registry, and command lane.
// Only generation and the final delivery adapter are synthetic external boundaries.
it("keeps queued media pending until delivery settles, including runtime shutdown", async () => {
  await withTestDir({ prefix: "openclaw-media-pending-queue-" }, async (tempDir) => {
    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      resetDetachedTaskLifecycleRuntimeForTests();
      resetGeneratedMediaTaskActivityForTests();
      resetTaskRegistryForTests({ persist: false });
      setRuntimeConfigSnapshot({ agents: { ownership: "explicit", entries: { main: {} } } });
      const queueContext = captureOpenClawStateWorkerContext();
      const payload = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001", "hex");
      const mediaPath = path.join(tempDir, "generated-proof.png");
      await fs.writeFile(mediaPath, payload);
      const received: Array<{ sessionKey: string; message: string; media: string[] }> = [];
      const server = createServer((request, response) => {
        void (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            sessionKey: string;
            message: string;
            media: string[];
          };
          received.push(body);
          response.writeHead(body.sessionKey.endsWith(":late-success") ? 200 : 409);
          response.end("recorded");
        })().catch((error: unknown) => {
          response.writeHead(500);
          response.end(String(error));
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected an ephemeral loopback listener");
      }
      const endpoint = `http://127.0.0.1:${address.port}`;
      const failures: string[] = [];
      const queueErrors: string[] = [];
      const milestones = new Map<
        string,
        { started: Deferred; queued: Deferred; entered: Deferred }
      >();
      const prepareMilestones = (sessionKey: string) => {
        const ready = {
          started: createDeferredCore(),
          queued: createDeferredCore(),
          entered: createDeferredCore(),
        };
        milestones.set(sessionKey, ready);
        return ready;
      };
      const awaitReadiness = async (ready: Promise<unknown>, work: Promise<void>[]) => {
        await Promise.race([
          ready,
          ...work.map(async (pending) => {
            await pending;
            throw new Error("Media work settled before its held delivery became ready");
          }),
        ]);
      };
      const runtimeOptions: Parameters<typeof startSessionDeliveryRuntime>[0] = {
        queueContext,
        log: { info() {}, warn() {}, error: (message) => queueErrors.push(message) },
        deliver: async (entry) => {
          if (entry.kind !== "agentTurn") {
            throw new Error("Expected the generated-media agent-turn entry");
          }
          const delivery = enqueueCommandInLane(`session:${entry.sessionKey}`, async () => {
            const media = await Promise.all(
              (entry.expectedMediaUrls ?? []).map(async (filename) => {
                expect(filename).toBe(mediaPath);
                return (await fs.readFile(filename)).toString("base64");
              }),
            );
            const result = await fetch(endpoint, {
              method: "POST",
              body: JSON.stringify({ sessionKey: entry.sessionKey, message: entry.message, media }),
            });
            await result.text();
            if (!result.ok) {
              throw new SessionDeliveryDeadLetteredError("synthetic recipient rejected delivery");
            }
          });
          milestones.get(entry.sessionKey)?.entered.resolve();
          await delivery;
        },
      };
      let stop = startSessionDeliveryRuntime(runtimeOptions);
      const mediaLifecycle = createMediaGenerationTaskLifecycle({
        toolName: "image_generate",
        taskKind: "image_generation",
        label: "Image generation",
        queuedProgressSummary: "Queued image generation",
        generatedLabel: "image",
        failureProgressSummary: "Image generation failed",
        eventSource: "image_generation",
        announceType: "image generation task",
        completionLabel: "image",
      });
      const lifecycle: typeof mediaLifecycle = {
        ...mediaLifecycle,
        recordTaskProgress(params) {
          mediaLifecycle.recordTaskProgress(params);
          if (
            params.progressSummary === MEDIA_GENERATION_QUEUED_COMPLETION_PROGRESS &&
            params.handle
          ) {
            milestones.get(params.handle.requesterSessionKey)?.queued.resolve();
          }
        },
      };
      const status = createMediaGenerationTaskStatusOwner({
        taskKind: "image_generation",
        toolName: "image_generate",
        nounLabel: "Image",
        completionLabel: "image",
        promptCompletionLabel: "images",
      });
      const gates: Deferred[] = [];
      const parents: Promise<void>[] = [];
      const background: Promise<void>[] = [];
      const scenarios: Array<{ name: string; handle: MediaGenerationTaskHandle }> = [];
      try {
        for (const name of ["late-success", "late-failure", "generation-failure"]) {
          const sessionKey = `agent:main:media-proof:${name}`;
          const ready = prepareMilestones(sessionKey);
          const gate = createDeferredCore();
          gates.push(gate);
          parents.push(
            enqueueCommandInLane(`session:${sessionKey}`, async () => {
              const started = await runMediaGenerationTask({
                lifecycle: {
                  ...lifecycle,
                  createTaskRun: (params) => {
                    const handle = lifecycle.createTaskRun(params);
                    if (!handle) {
                      throw new Error("Expected the real media task ledger to accept the task");
                    }
                    scenarios.push({ name, handle });
                    return handle;
                  },
                },
                generationLabel: "image",
                sessionKey,
                requesterAgentId: "main",
                prompt: name,
                requestKey: name,
                scheduleBackgroundWork: (work) => background.push(work()),
                onFailure: (message) => failures.push(message),
                run: async () => {
                  if (name === "generation-failure") {
                    throw new Error("synthetic provider generation failure");
                  }
                  return {
                    provider: "fixture",
                    model: "local-image",
                    count: 1,
                    wakeResult: "Generated proof image",
                    attachments: [{ type: "image" as const, path: mediaPath }],
                    contentText: "Generated proof image",
                    details: { paths: [mediaPath] },
                  };
                },
              });
              expect(started.details).toMatchObject({ async: true, status: "started" });
              ready.started.resolve();
              await gate.promise;
            }),
          );
        }
        await awaitReadiness(
          Promise.all([...milestones.values()].map((ready) => ready.started.promise)),
          parents,
        );
        await awaitReadiness(
          Promise.all(
            [...milestones.values()].flatMap((ready) => [
              ready.queued.promise,
              ready.entered.promise,
            ]),
          ),
          [...parents, ...background],
        );
        expect(await loadPendingSessionDeliveries(queueContext)).toHaveLength(3);
        for (const { handle } of scenarios) {
          expect(getCommandLaneSnapshot(`session:${handle.requesterSessionKey}`)).toMatchObject({
            activeCount: 1,
            queuedCount: 1,
          });
        }
        // The producer's fake-clock regressions cover the 120-second deadline.
        // This composition proves real custody and final readback without a CI sleep.
        expect.soft(received).toEqual([]);
        expect.soft(failures).toEqual([]);
        for (const { name, handle } of scenarios) {
          const task = getTaskById(handle.taskId);
          expect.soft(task, name).toMatchObject({ status: "running" });
          expect.soft(task?.terminalOutcome, name).toBeUndefined();
          expect.soft(task?.progressSummary, name).toBe("Media task finished; completion queued");
          if (task) {
            expect.soft(status.buildTaskStatusText(task), name).toContain("Finish or yield");
          }
          console.log(
            "MEDIA_QUEUE_BEFORE_YIELD",
            JSON.stringify({
              scenario: name,
              status: task?.status,
              terminalOutcome: task?.terminalOutcome ?? null,
              progress: task?.progressSummary,
            }),
          );
        }
        for (const gate of gates) {
          gate.resolve();
        }
        await Promise.all(parents);
        await Promise.all(background);
        await stop();
        expect(await loadPendingSessionDeliveries(queueContext)).toHaveLength(0);
        expect(received).toHaveLength(3);
        for (const { name, handle } of scenarios) {
          const task = getTaskById(handle.taskId);
          const receipt = received.find((item) => item.sessionKey === handle.requesterSessionKey);
          expect(receipt?.media).toEqual(
            name === "generation-failure" ? [] : [payload.toString("base64")],
          );
          if (name === "generation-failure") {
            expect(task).toMatchObject({
              status: "failed",
              error: "synthetic provider generation failure",
            });
          } else if (name === "late-failure") {
            expect(task).toMatchObject({ status: "succeeded", terminalOutcome: "blocked" });
            expect(task?.terminalSummary).toContain(mediaPath);
          } else {
            expect(task).toMatchObject({ status: "succeeded" });
            expect.soft(task?.terminalOutcome).not.toBe("blocked");
            expect(task?.error).toBeUndefined();
          }
          console.log(
            "MEDIA_QUEUE_AFTER_YIELD",
            JSON.stringify({
              scenario: name,
              status: task?.status,
              terminalOutcome: task?.terminalOutcome ?? null,
              received: Boolean(receipt),
              mediaCount: receipt?.media.length,
            }),
          );
        }
        expect(queueErrors).toEqual([]);
        stop = startSessionDeliveryRuntime(runtimeOptions);
        const shutdownSession = "agent:main:media-proof:runtime-stop";
        const shutdownReady = prepareMilestones(shutdownSession);
        const shutdownGate = createDeferredCore();
        gates.push(shutdownGate);
        const shutdownHandle = lifecycle.createTaskRun({
          sessionKey: shutdownSession,
          requesterAgentId: "main",
          prompt: "shutdown observer proof",
        });
        if (!shutdownHandle) {
          throw new Error("Expected a task for the shutdown proof");
        }
        let shutdownBackground: Promise<void> | undefined;
        const shutdownParent = enqueueCommandInLane(`session:${shutdownSession}`, async () => {
          scheduleMediaGenerationTaskCompletion({
            lifecycle,
            handle: shutdownHandle,
            scheduleBackgroundWork: (work) => {
              shutdownBackground = work();
              background.push(shutdownBackground);
            },
            progressSummary: "Generating image",
            toolName: "Image generation",
            onWakeFailure: (message) => failures.push(message),
            run: async () => ({
              provider: "fixture",
              model: "local-image",
              count: 1,
              wakeResult: "ready",
              attachments: [{ type: "image" as const, path: mediaPath }],
            }),
          });
          shutdownReady.started.resolve();
          await shutdownGate.promise;
        });
        parents.push(shutdownParent);
        await awaitReadiness(shutdownReady.started.promise, [shutdownParent]);
        if (!shutdownBackground) {
          throw new Error("Expected scheduled shutdown media work");
        }
        await awaitReadiness(
          Promise.all([shutdownReady.queued.promise, shutdownReady.entered.promise]),
          [shutdownParent, shutdownBackground],
        );
        expect(getCommandLaneSnapshot(`session:${shutdownSession}`)).toMatchObject({
          activeCount: 1,
          queuedCount: 1,
        });
        const failuresBeforeStop = failures.length;
        const stopping = stop();
        expect(getTaskById(shutdownHandle.taskId)).toMatchObject({ status: "running" });
        expect(getTaskById(shutdownHandle.taskId)?.terminalOutcome).toBeUndefined();
        expect(failures).toHaveLength(failuresBeforeStop);
        expect(await loadPendingSessionDeliveries(queueContext)).toHaveLength(1);
        expect(received).toHaveLength(3);
        shutdownGate.resolve();
        await Promise.all(parents);
        await stopping;
        await Promise.all(background);
        expect(received).toHaveLength(4);
        expect(await loadPendingSessionDeliveries(queueContext)).toHaveLength(0);
        expect(getTaskById(shutdownHandle.taskId)).toMatchObject({
          status: "succeeded",
          terminalOutcome: "blocked",
        });
        expect(getTaskById(shutdownHandle.taskId)?.terminalSummary).toContain(mediaPath);
        console.log(
          "MEDIA_QUEUE_OBSERVER_STOP",
          "observer joined; admitted delivery and task settled once",
        );
      } finally {
        for (const gate of gates) {
          gate.resolve();
        }
        await Promise.all(parents);
        await Promise.all(background);
        await stop();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await closeOpenClawStateDatabaseAsync();
        resetTaskRegistryForTests({ persist: false });
        resetGeneratedMediaTaskActivityForTests();
        resetDetachedTaskLifecycleRuntimeForTests();
        resetRecentMediaGenerationDuplicateGuardsForTests();
        clearRuntimeConfigSnapshot();
      }
    });
  });
}, 30_000);
