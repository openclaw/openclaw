import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKER_COMPUTER_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-computer.js";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import { abortable } from "../../agents/embedded-agent-runner/run/abortable.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { FailoverError, resolveModelFallbackError } from "../../agents/failover-error.js";
import { runWithModelFallback } from "../../agents/model-fallback-runner.js";
import { createAgentRunDirectAbortError } from "../../agents/run-termination.js";
import { installSessionPlacementAdmissionProvider } from "../../agents/session-placement-admission.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import {
  attachErrorDiagnostic,
  formatErrorMessageForDisplay,
} from "../../infra/error-diagnostics.js";
import { saveMediaBuffer } from "../../media/store.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import type { WorkerGitHubLaunchBinding } from "../../worker/launch-descriptor.js";
import type { PreparedWorkerComputer } from "./computer-transport.js";
import * as skillTransfer from "./skill-resource-transfer.js";
import { WorkerRunnerCapacityError, type WorkerTunnelHandle } from "./tunnel-contract.js";
import type { WorkerGitHubBindingGrant } from "./worker-github-binding-contract.js";
import * as githubBinding from "./worker-github-binding.js";
import {
  createLauncher,
  executeTurn,
  expectUncalled,
  localResult as defaultLocalResult,
  runIdentity,
} from "./worker-turn-launcher-flow.test-support.js";
import * as fx from "./worker-turn-launcher.test-support.js";

afterAll(closeStateDatabaseForTest);

const readGitHubFact = vi.hoisted(() => vi.fn());
// mock-isolation: Worker launches consume facts without starting identity discovery.
vi.mock("../github-publication-discovery.js", () => ({
  readGitHubPublicationFact: readGitHubFact,
}));

const primaryModes = [
  "provider",
  "overload",
  "http-507",
  "abort",
  "timeout",
  "returned",
  "returned-abort",
  "returned-timeout",
  "returned-success",
] as const;
const remoteCase = (
  label: string,
  nodeDeviceId: string | undefined,
  providerId = "device",
  overrides: {
    primary?: (typeof primaryModes)[number];
    closeFails?: boolean;
    pauseSkillCleanup?: boolean;
  } = {},
) => ({ label, nodeDeviceId, providerId, closeFails: false, ...overrides });

function environmentFor(
  tunnel: WorkerTunnelHandle,
  overrides: Partial<fx.WorkerTurnEnvironmentService> = {},
): fx.WorkerTurnEnvironmentService {
  return {
    ...fx.unusedEnvironments(),
    get: vi.fn(fx.attachedEnvironment),
    acquireTurnCredential: vi.fn(async () => fx.credential()),
    startTunnel: vi.fn(async () => tunnel),
    ...overrides,
  };
}

describe("worker launch capabilities", () => {
  beforeEach(async () => {
    await fx.setupWorkerTurnLauncherTest();
    readGitHubFact.mockReset().mockReturnValue({ available: false });
  });
  afterEach(() => fx.cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true }));

  it.each([
    { label: "available", available: true, revoked: false },
    { label: "unavailable", available: false, revoked: false },
    { label: "revoked before launch", available: true, revoked: true },
  ])(
    "carries only a current GitHub identity in the launch envelope ($label)",
    async ({ available, revoked }) => {
      await fx.seedActivePlacement();
      const github: WorkerGitHubLaunchBinding = {
        token: "synthetic-turn-bound-github-token",
        login: "shared-bot",
        branch: "openclaw/session-branch",
        remoteUrl: "https://github.com/owner/repo.git",
        gitAuthor: { name: "Shared Bot", email: "shared@example.test" },
      };
      let current = true;
      const controller = new AbortController();
      const revokedError = new Error("GitHub grant revoked before dispatch");
      const grant: WorkerGitHubBindingGrant = {
        binding: github,
        signal: controller.signal,
        assertCurrent() {
          if (!current) {
            throw revokedError;
          }
        },
        refresh: async () => undefined,
        revoke: async () => controller.abort(),
      };
      using binding = vi.spyOn(githubBinding, "bindWorkerGitHubTurn");
      binding.mockResolvedValue(available ? grant : undefined);
      const dispatchLaunch = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(
        async ({ plan }) => {
          if (available) {
            expect(plan.assignment.github).toEqual(github);
          } else {
            expect(plan.assignment).not.toHaveProperty("github");
          }
          throw new WorkerRunnerCapacityError();
        },
      );
      const tunnel: WorkerTunnelHandle = fx.createWorkerTurnTunnel({
        launchTurn: async (request) => {
          request.assertCurrent?.();
          return dispatchLaunch(request);
        },
        measureLaunchTurn: (plan, claim) => {
          if (revoked) {
            expect(plan.assignment.github).toEqual(github);
            current = false;
          }
          return fx.measureLaunchTurn(plan, claim);
        },
        stageAttachments: vi.fn(),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
      });
      let publicationOffered = false;
      const environments = environmentFor(tunnel, {
        createGatewayTools: async ({ prepareTools }) => {
          const tools = (await prepareTools?.([])) ?? [];
          publicationOffered = tools.some((tool) => tool.name === "github_publish");
          return tools;
        },
      });
      const provider = createLauncher({ environments });
      const execution = executeTurn(provider, "run-github", vi.fn());
      if (revoked) {
        await expect(execution).rejects.toBe(revokedError);
        expect(dispatchLaunch).not.toHaveBeenCalled();
      } else {
        await expect(execution).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
        expect(dispatchLaunch).toHaveBeenCalledOnce();
      }
      expect(publicationOffered).toBe(true);
      expect(controller.signal.aborted).toBe(available);
    },
  );

  it.each([
    { missingFeature: undefined, modelHasVision: undefined, allowed: true },
    { missingFeature: undefined, modelHasVision: true, allowed: true },
    { missingFeature: undefined, modelHasVision: false, allowed: false },
    { missingFeature: WORKER_COMPUTER_PROTOCOL_FEATURE, modelHasVision: true, allowed: false },
    { modelHasVision: true, supervisorAdmitsComputer: false, allowed: false },
  ])(
    "grants computer with negotiated features, supervisor vocabulary, and model vision (%j)",
    async ({ missingFeature, modelHasVision, supervisorAdmitsComputer = true, allowed }) => {
      await fx.seedActivePlacement();
      const environment = fx.attachedEnvironment();
      if (!missingFeature) {
        environment.bootstrapReceipt!.protocolFeatures.push(WORKER_COMPUTER_PROTOCOL_FEATURE);
      }
      const computer = fx.computerDescriptor("worker-desktop");
      const image = {
        type: "image" as const,
        data: createSolidPngBuffer(2, 2, { r: 255, g: 0, b: 0 }).toString("base64"),
        mimeType: "image/png",
      };
      const bind = vi.fn(() => ({ resolveNode: async () => computer, invoke: vi.fn() }));
      const prepareComputer = vi.fn(async () => ({
        descriptor: computer,
        bind,
        close: vi.fn(async () => {}),
      }));
      const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async ({ plan }) => {
        expect(plan.assignment.computer).toEqual(allowed ? computer : undefined);
        const prompt = plan.assignment.prompt;
        const images = Array.isArray(prompt) ? prompt.filter((part) => part.type === "image") : [];
        expect(images).toEqual(modelHasVision === true ? [image] : []);
        expect(plan.assignment.toolAuthority.allowedToolNames.includes("computer")).toBe(allowed);
        throw new WorkerRunnerCapacityError();
      });
      const tunnel: WorkerTunnelHandle = fx.createWorkerTurnTunnel({
        launchTurn,
        readLaunchToolNames: async () =>
          (await fx.readLaunchToolNames()).filter(
            (name) => supervisorAdmitsComputer || name !== "computer",
          ),
        stageAttachments: vi.fn(async () => {}),
        quiesceWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
      });
      const environments = environmentFor(tunnel, {
        get: vi.fn(() => environment),
        prepareComputer,
      });
      const provider = createLauncher({ environments });
      await expect(
        provider.executeTurn(
          runIdentity("run-computer"),
          { ...fx.turn("run-computer"), toolsAllow: ["computer"], modelHasVision, images: [image] },
          defaultLocalResult,
        ),
      ).rejects.toBeInstanceOf(WorkerRunnerCapacityError);
      expect(launchTurn).toHaveBeenCalledOnce();
      expect(tunnel.stageAttachments).toHaveBeenCalledTimes(modelHasVision === true ? 1 : 0);
      expect(prepareComputer).toHaveBeenCalledTimes(
        !missingFeature && modelHasVision !== false ? 1 : 0,
      );
      expect(bind).toHaveBeenCalledTimes(allowed ? 1 : 0);
    },
  );

  it.each([
    remoteCase("SSH", undefined, "fake"),
    remoteCase("paired-device", "paired-node-1"),
    remoteCase("cloud-node", "cloud-node-1", "crabbox"),
    remoteCase("cloud-node", "cloud-node-1", "crabbox", { closeFails: true }),
    remoteCase("paused skill cleanup", "paired-node-1", "device", { pauseSkillCleanup: true }),
    ...primaryModes.flatMap((primary) =>
      (primary.startsWith("returned") ? [true] : [false, true]).map((closeFails) =>
        remoteCase(primary, "paired-node-1", "device", { primary, closeFails }),
      ),
    ),
  ])(
    "settles $label remote-exec output and restores attachment prompts before cleanup (close fails: $closeFails)",
    async ({ nodeDeviceId, providerId, closeFails, primary, pauseSkillCleanup }) => {
      const returnedInterruption = primary === "returned-abort" || primary === "returned-timeout";
      const returnedError = {
        kind: "incomplete_turn" as const,
        message: "recorded primary failure",
        fallbackSafe: true,
      };
      const localResult: EmbeddedAgentRunResult = {
        payloads: [
          primary === "returned"
            ? { text: returnedError.message, isError: true }
            : { text: "local remote reply" },
        ],
        meta: { durationMs: 17 },
      };
      if (returnedInterruption || primary === "returned-success") {
        localResult.didSendViaMessagingTool = true;
        localResult.messagingToolSentTexts = ["already delivered"];
      }
      if (primary === "returned") {
        Object.assign(localResult.meta, {
          error: returnedError,
          replayInvalid: false,
          livenessState: "blocked",
          toolSummary: { calls: 1, tools: ["computer"], failures: 1 },
        });
      }
      if (returnedInterruption) {
        Object.assign(localResult.meta, {
          aborted: true,
          replayInvalid: true,
          providerStarted: true,
          stopReason: primary === "returned-timeout" ? "timeout" : "aborted",
        });
        if (primary === "returned-timeout") {
          localResult.meta.timeoutPhase = "provider";
        }
      }
      const providerFailure =
        primary === "provider"
          ? ({ reason: "auth", status: 401 } as const)
          : primary === "overload"
            ? ({ reason: "overloaded", status: 503 } as const)
            : primary === "http-507"
              ? ({ reason: "server_error", status: 507 } as const)
              : undefined;
      const primaryError = providerFailure
        ? primary === "http-507"
          ? Object.assign(new Error("provider request failed"), { status: 507 })
          : new FailoverError("provider failed", providerFailure)
        : primary === "abort"
          ? createAgentRunDirectAbortError()
          : primary === "timeout"
            ? await abortable(
                AbortSignal.abort(new DOMException("turn timed out", "TimeoutError")),
                Promise.resolve(),
              ).catch((error: unknown) => {
                if (!(error instanceof Error)) {
                  throw error;
                }
                return error;
              })
            : undefined;
      if (primaryError) {
        attachErrorDiagnostic(primaryError, "original provider diagnostic");
        Object.freeze(primaryError);
      }
      const remote = path.join(await realpath(fx.root), "remote");
      await mkdir(remote);
      const bytes = Buffer.from("remote attachment");
      const saved = await saveMediaBuffer(bytes, "text/plain", "inbound", bytes.length, "note.txt");
      const inputTurn = {
        ...fx.turn("run-remote-exec"),
        transcriptPrompt: "Canonical transcript request",
        media: [{ path: saved.path, contentType: "text/plain" }],
      };
      const originalPrompt = inputTurn.prompt;
      const expectRestoredPrompts = () =>
        expect(inputTurn).toMatchObject({
          prompt: originalPrompt,
          transcriptPrompt: "Canonical transcript request",
        });
      await fx.seedActivePlacement("remote-exec", remote);
      const order: string[] = [];
      const launchTurn = vi.fn();
      const tunnel: WorkerTunnelHandle = fx.createWorkerTurnTunnel({
        launchTurn,
        runWorkspaceCommand: async (command) =>
          await runCommandWithTimeout([...command.argv], {
            cwd: remote,
            input: command.input,
            timeoutMs: 5_000,
            signal: command.signal,
          }),
        quiesceWorkspace: vi.fn(async () => {
          order.push("quiesce");
          return {
            assertActive: vi.fn(async () => {}),
            resume: vi.fn(async () => {
              order.push("resume");
            }),
          };
        }),
        syncWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(async (request) => {
          order.push("reconcile");
          return fx.reconcileUnchangedLocalWorkspace(request);
        }),
      });
      const secret = ["synthetic", "cleanup", "credential"].join("-");
      const cleanupDetail = `native close failed: HTTP 401 request timed out Authorization: Bearer ${secret} ${"x".repeat(3000)}`;
      const cleanupError = new AggregateError([new Error(cleanupDetail)], "computer close failed");
      const closeComputer = vi.fn(async () => {
        expectRestoredPrompts();
        order.push("close");
        if (closeFails) {
          throw cleanupError;
        }
      });
      const computer: PreparedWorkerComputer = {
        descriptor: fx.computerDescriptor(nodeDeviceId ?? "unused-ssh-node"),
        bind: () => {
          throw new Error("unexpected computer binding");
        },
        close: closeComputer,
      };
      const environments = environmentFor(tunnel, {
        get: vi.fn(() =>
          nodeDeviceId
            ? { ...fx.attachedEnvironment(), providerId, nodeDeviceId, sshEndpoint: null }
            : fx.attachedEnvironment(),
        ),
        acquireTurnCredential: fx.unusedEnvironments().acquireTurnCredential,
        prepareComputer: vi.fn(async () => (nodeDeviceId ? computer : undefined)),
      });
      const provider = createLauncher({ environments });
      const selection = {
        cfg: {},
        manifestPlugins: [],
        provider: "fixture-provider",
        model: "fixture-model",
        fallbacksOverride: ["fixture-next/fixture-model"],
      };
      const successorGate = vi.spyOn(provider, "assertCompactionSuccessorAllowed");
      let retainedNodeAuthority: (() => void) | undefined;
      const runLocal = vi.fn(() =>
        fx.withWorkerCompactionAdoption("run-remote-exec", async (adopt) => {
          order.push("local");
          expect(inputTurn.prompt).toContain(`${originalPrompt}\n\nCurrent attachment originals`);
          expect(inputTurn.transcriptPrompt).toBe("Canonical transcript request");
          const placementBefore = fx.placements.get(fx.SESSION_ID);
          const entryBefore = loadSessionEntry(fx.sessionTarget);
          expect(placementBefore?.turnClaim).toMatchObject({
            owner: "local",
            runId: "run-remote-exec",
          });
          await expect(adopt(fx.SESSION_ID)).resolves.toBeUndefined();
          expect(successorGate).not.toHaveBeenCalled();
          await expect(adopt("session-remote-successor")).rejects.toThrow(
            /worker placement.*same session ID/u,
          );
          expect(fx.placements.get(fx.SESSION_ID)).toEqual(placementBefore);
          expect(loadSessionEntry(fx.sessionTarget)).toEqual(entryBefore);
          expect(await fx.placements.getAsync("session-remote-successor")).toBeUndefined();
          if (nodeDeviceId) {
            const assertCurrent = getPluginRuntimeGatewayRequestScope()?.assertNodeExecutionCurrent;
            expect(assertCurrent).toBeTypeOf("function");
            const request = {
              runId: "run-remote-exec",
              agentId: "main",
              nodeId: nodeDeviceId,
              workspace: {
                workspaceDir: remote,
                environmentId: fx.ENVIRONMENT_ID,
                sessionId: fx.SESSION_ID,
                sessionKey: fx.SESSION_KEY,
                ownerEpoch: fx.OWNER_EPOCH,
              },
            };
            retainedNodeAuthority = () => assertCurrent!(request);
            retainedNodeAuthority();
            for (const changed of [
              { ...request, runId: "other" },
              { ...request, nodeId: "other" },
              ...[
                { ownerEpoch: fx.OWNER_EPOCH + 1 },
                { environmentId: "other" },
                { sessionId: "other" },
                { workspaceDir: "/other" },
              ].map((workspace) =>
                Object.assign({}, request, {
                  workspace: Object.assign({}, request.workspace, workspace),
                }),
              ),
            ]) {
              expect(() => assertCurrent!(changed)).toThrow("no longer current");
            }
            const original = environments.get(fx.ENVIRONMENT_ID)!;
            if (original.state !== "attached") {
              throw new Error("expected an attached environment");
            }
            for (const changed of [
              { ...original, nodeDeviceId: "replacement" },
              { ...original, leaseId: "replacement" },
            ]) {
              vi.mocked(environments.get).mockReturnValueOnce(changed);
              await Promise.resolve();
              expect(retainedNodeAuthority).toThrow("no longer current");
            }
          }
          if (primaryError) {
            throw primaryError;
          }
          return localResult;
        }),
      );
      const resourceCleanup = pauseSkillCleanup
        ? { entered: createDeferred(), release: createDeferred() }
        : undefined;
      const skillCleanupError = new Error("synthetic security cleanup failure");
      const snapshot = { skills: [], resolvedSkills: [], discoverySkills: [], prompt: "" };
      const transfer = resourceCleanup
        ? vi.spyOn(skillTransfer, "transferSkillResources").mockResolvedValue({
            source: snapshot,
            snapshot,
            mounts: [],
            assertCurrent: () => {},
            cleanup: async () => {
              resourceCleanup.entered.resolve();
              await resourceCleanup.release.promise;
              throw skillCleanupError;
            },
          })
        : undefined;
      const uninstall = installSessionPlacementAdmissionProvider(provider);
      const operation = provider.executeTurn(runIdentity("run-remote-exec"), inputTurn, runLocal);
      try {
        if (resourceCleanup) {
          await resourceCleanup.entered.promise;
          expect(fx.placements.get(fx.SESSION_ID)?.turnClaim).not.toBeNull();
          expect(retainedNodeAuthority).toThrow("no longer current");
          expect(closeComputer).not.toHaveBeenCalled();
          resourceCleanup.release.resolve();
          await expect(operation).rejects.toBe(skillCleanupError);
        } else if (primaryError) {
          const failure = await operation.catch((error: unknown) => error);
          expect(failure).toBe(primaryError);
          const display = formatErrorMessageForDisplay(failure);
          expect(display).toContain("original provider diagnostic");
          if (closeFails) {
            expect.soft(display).toContain("computer close failed | native close failed");
          }
          expect(display).not.toContain(secret);
          if (providerFailure) {
            expect(primaryError).toMatchObject(
              primary === "http-507" ? { status: providerFailure.status } : providerFailure,
            );
            expect.soft(resolveModelFallbackError(failure)).toEqual({
              kind: closeFails ? "terminal" : "failover",
              error:
                closeFails || primary !== "http-507"
                  ? primaryError
                  : expect.objectContaining(providerFailure),
            });
          }
          const failures = [
            failure,
            ...(providerFailure && closeFails
              ? [
                  new Error("outer failure", { cause: failure }),
                  new AggregateError([failure], "outer aggregate"),
                ]
              : []),
          ];
          for (const error of failures) {
            const run = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(localResult);
            const fallback = runWithModelFallback({
              ...selection,
              cfg: undefined,
              run,
            });
            if (providerFailure && !closeFails) {
              await expect(fallback).resolves.toMatchObject({
                outcome: "completed",
                result: localResult,
                attempts: [providerFailure],
              });
              expect(run).toHaveBeenCalledTimes(2);
            } else {
              await expect(fallback).rejects.toBe(error);
              expect(run).toHaveBeenCalledOnce();
            }
          }
        } else {
          const result = await operation;
          if (!closeFails) {
            expect(result).toBe(localResult);
          } else {
            const prefix = "Computer cleanup also failed: ";
            const diagnostic = result.payloads?.at(-1);
            expect(diagnostic).toMatchObject({
              isError: true,
              text: expect.stringContaining(`${prefix}computer close failed | native close failed`),
            });
            expect(diagnostic?.text?.length).toBeLessThanOrEqual(prefix.length + 1024);
            expect(result.meta.error).toMatchObject({
              kind: localResult.meta.error?.kind ?? "incomplete_turn",
              fallbackSafe: false,
            });
            expect(result.meta.error?.message).toContain(diagnostic?.text);
            if (localResult.meta.error) {
              expect(result.meta.error?.message).toContain(localResult.meta.error.message);
            }
            expect(result).toEqual({
              ...localResult,
              payloads: [...(localResult.payloads ?? []), diagnostic],
              meta: { ...localResult.meta, error: result.meta.error, replayInvalid: true },
            });
            expect(JSON.stringify(result)).not.toContain(secret);
            const runCandidate = vi.fn(async () => result);
            const entry = await runEmbeddedAgentEntry({
              selection,
              identity: { runId: "settlement-entry", agentId: "main", sessionId: fx.SESSION_ID },
              harness: {
                workspaceDir: fx.root,
                sessionKey: fx.SESSION_KEY,
                preparation: { kind: "direct" },
                resolveRuntimeOverride: () => "openclaw",
              },
              behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
              sessionOverride: { kind: "preserve" },
              runCandidate,
            });
            expect(runCandidate).toHaveBeenCalledOnce();
            expect(entry.attempts).toEqual([]);
            expect(entry.terminal).toMatchObject({
              outcome: { status: primary === "returned-timeout" ? "timeout" : "error" },
              metadata: { replayInvalid: true },
            });
            if (returnedInterruption) {
              expect(entry.terminal.metadata).toMatchObject({
                aborted: true,
                stopReason: localResult.meta.stopReason,
              });
            }
          }
        }
      } finally {
        resourceCleanup?.release.resolve();
        await operation.catch(() => undefined);
        transfer?.mockRestore();
        uninstall();
        inputTurn.preparedRunAdmission.close();
      }
      expectRestoredPrompts();
      expect(closeComputer).toHaveBeenCalledTimes(nodeDeviceId ? 1 : 0);
      expect(order).toEqual([
        "local",
        ...(nodeDeviceId ? ["close"] : []),
        "quiesce",
        "reconcile",
        "resume",
      ]);
      expectUncalled(launchTurn, environments.acquireTurnCredential);
      expect(await fx.placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      const placement = fx.placements.get(fx.SESSION_ID);
      expect([placement?.state, placement?.turnClaim]).toEqual(["active", null]);
      if (retainedNodeAuthority) {
        expect(retainedNodeAuthority).toThrow("no longer current");
      }
    },
  );
});
