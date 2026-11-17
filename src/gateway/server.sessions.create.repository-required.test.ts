import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { clearGitHubCredentialVerificationCache } from "../agents/github-oauth-client.js";
import {
  resolveManagedGitHubProfileDir,
  writeManagedGitHubProfileFiles,
} from "../agents/github-tool-identity.js";
import { loadSessionEntry, upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { NodeWorkerWorkspaceRuntime } from "../node-host/node-worker-workspace.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { captureSessionTarget } from "../sessions/session-controller.lifecycle.js";
import { captureSessionControllerStop, stopSession } from "../sessions/session-controller.stop.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import * as oauth from "./github-oauth-lifecycle.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import { identifiedClient } from "./server-methods/sessions-sharing.test-support.js";
import { createGatewayWorkerDispatchAdmission } from "./server-worker-placement-dispatch-admission.js";
import { createRequiredWorkerSessionPreparation } from "./server-worker-required-profile.js";
import {
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";
import { createNodeWorkerRepositoryPreparation } from "./worker-environments/node-worker-repository-preparation.js";
import { coordinateWorkerPlacementDispatch } from "./worker-environments/placement-dispatch-coordinator.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import { writePlacementEnvironmentFixture } from "./worker-environments/placement-test-fixtures.js";
import { createRepositoryPolicySource } from "./worker-environments/repository-policy-node.test-support.js";
import { deriveEnvironmentIntent } from "./worker-environments/service-contract.js";
import { captureWorkspaceManifest } from "./worker-environments/workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./worker-environments/workspace-manifest.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearGitHubCredentialVerificationCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Actual RPC admission/creation and dispatch owners, with native Git/checkpoint effects.
// Provider allocation and remote transport/account responses remain synthetic.
test.each(["allowed", "policy", "source", "stop", "caller"] as const)(
  "required repository sessions.create retains authority after ACK: %s",
  async (scenario) => {
    const { dir, storePath } = await createSessionStoreDir();
    const config = await getGatewayConfigModule();
    const key = "agent:main:dashboard:required-repository-rpc";
    const profileId = "ghp_88888888888888888888888888888888";
    await config.writeConfigFile({
      cloudWorkers: {
        requiredProfile: "development",
        profiles: { development: { provider: "fake", settings: {} } },
      },
      gateway: { repositoryIntegration: "repository-policy" },
      tools: { github: { profileId } },
    });
    const profileDir = resolveManagedGitHubProfileDir({
      agentId: "main",
      scope: "system",
      profileId,
    });
    await writeManagedGitHubProfileFiles(profileDir, {
      login: "fixture",
      token: "synthetic-managed-credential",
    });
    const owner = ensureProfileForEmail("repository-creator@example.invalid");
    const catalog = await prepareUserProfileCatalog();
    const client = { ...identifiedClient(owner.id), connId: "repository-creator-connection" };
    client.connect.scopes = ["operator.admin"];
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "repository-policy",
      source: "fixture",
      origin: "workspace",
      enabled: true,
      configSchema: false,
    });
    record.contracts = { repositoryIntegrations: ["repository"] };
    builder.registry.plugins.push(record);
    let policyCurrent = true;
    const assertPolicy = () => {
      if (!policyCurrent) {
        throw new Error("Repository policy revoked");
      }
    };
    builder.createApi(record, { config: config.getRuntimeConfig() }).registerRepositoryIntegration({
      version: 1,
      preparedCapacity: "image",
      resolveConnectionIdentity: () => undefined,
      async withIdentity(context, run) {
        context.assertCurrent();
        assertPolicy();
        return run({
          env: context.env,
          assertCurrent: assertPolicy,
          readNativeCredential: async () => {
            throw new Error("Managed profiles own credentials");
          },
        });
      },
    });
    setActivePluginRegistry(builder.registry);
    const verify = vi.fn(async () => Response.json({ id: 202, login: "fixture" }));
    vi.stubGlobal("fetch", verify);
    vi.spyOn(oauth, "requestCurrentGitHubOAuthRefresh").mockResolvedValue(undefined);
    const origin = path.join(dir, "origin");
    const { baseCommit, base } = await createRepositoryPolicySource(origin);
    const database = openOpenClawStateDatabase();
    const placements = createWorkerSessionPlacementStore({ database });
    const repositories = getSessionRepositoryWorkspaceStore();
    const entry = () => loadSessionEntry({ agentId: "main", sessionKey: key, storePath });
    const harness = await createHarness(database, placements, {
      requiresNodeEnrollment: true,
      resolveWorkspace: async () => {
        const workspaceId = entry()?.repositoryWorkspaceId;
        if (!workspaceId) {
          throw new Error("RPC did not create repository owner");
        }
        const repository = (await repositories.prepare(workspaceId)).current();
        if (!repository) {
          throw new Error("Repository owner unavailable");
        }
        return { kind: "repository", repository };
      },
    });
    const resume = createDeferredCore();
    const entered = createDeferredCore();
    const stopped = createDeferredCore();
    const complete = createDeferredCore<unknown>();
    const originalIntent = harness.environments.prepareProjectIntent;
    harness.environments.prepareProjectIntent = async (selected, request) => {
      entered.resolve();
      await resume.promise;
      expect(request).toMatchObject({ imageReserve: true });
      expect(request).not.toHaveProperty("readNativeCredential");
      // Delay runtime allocation only; real repository startup owns identity admission.
      return originalIntent(selected, request);
    };
    const originalCreate = harness.environments.createWithRequest;
    harness.environments.createWithRequest = async (request) => {
      const identity = deriveEnvironmentIntent(request.idempotencyKey);
      Object.assign(harness.ready, identity);
      Object.assign(harness.attached, identity);
      return originalCreate(request);
    };
    const originalAttach = harness.environments.attachSession;
    harness.environments.attachSession = async (request) => {
      const credential = await originalAttach(request);
      const environment = harness.environments.get(request.environmentId)!;
      environment.attachedSessionIds = [request.sessionId];
      writePlacementEnvironmentFixture(database, environment);
      return { ...credential, environmentId: request.environmentId, sessionId: request.sessionId };
    };
    const nodeHome = path.join(dir, "node-home");
    await fs.mkdir(nodeHome);
    const runtime = new NodeWorkerWorkspaceRuntime({
      root: path.join(dir, "node-state"),
      env: { PATH: process.env.PATH, HOME: nodeHome },
    });
    const commands: string[] = [];
    const originalTunnel = harness.environments.startTunnel;
    harness.environments.startTunnel = async (request) => ({
      ...(await originalTunnel(request)),
      syncWorkspace: async (input) => {
        if (input.source.kind !== "repository") {
          throw new Error("Expected repository");
        }
        const preparation = createNodeWorkerRepositoryPreparation(async (command) => {
          command.assertCurrent?.();
          commands.push(command.seed ? "seed" : "git");
          return runtime.exec({
            gatewayNamespace: "rpc-proof",
            environmentId: "worker",
            sessionId: entry()!.sessionId,
            generation: 1,
            argv: [...command.argv],
            input: command.input,
            seed: command.seed,
            resetWorkspace: command.resetWorkspace,
            timeoutMs: command.timeoutMs,
          });
        }, input.authorize!);
        const prepared = await preparation.prepareRepository({
          origin: pathToFileURL(origin).href,
          commit: baseCommit,
          gitToken: input.source.gitToken,
        });
        if (prepared.kind !== "prepared") {
          throw new Error("Checkout failed");
        }
        return {
          ...prepared.result,
          mode: "repository",
          baseManifestRef: prepared.result.manifestRef,
        };
      },
      reconcileWorkspace: async (input) => {
        if (input.source.kind !== "repository") {
          throw new Error("Expected repository");
        }
        const manifest = await captureWorkspaceManifest({
          root: input.remoteWorkspaceDir,
          baseCommit,
        });
        const checkpoint = await input.source.prepareCheckpoint({
          stagingRoot: input.remoteWorkspaceDir,
          baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
          currentManifestRaw: serializeWorkerWorkspaceManifest(manifest.manifest),
          baseManifestRef: base.manifestRef,
          currentManifestRef: manifest.manifestRef,
        });
        return {
          manifestRef: manifest.manifestRef,
          changed: false,
          verifyStable: async () => {
            expect(
              (await captureWorkspaceManifest({ root: input.remoteWorkspaceDir, baseCommit }))
                .manifestRef,
            ).toBe(manifest.manifestRef);
          },
          verifyLocalStable: () => checkpoint.verify(),
          publishStagedResult: async () => {
            await checkpoint.publish();
          },
          discardPreparedStagedResult: () => checkpoint.discard(),
        };
      },
    });
    const originalDispatch = harness.service.dispatch;
    harness.service.dispatch = (...args) => {
      args[3]?.addEventListener("abort", () => stopped.resolve(), { once: true });
      const result = originalDispatch(...args);
      void result.then(
        (value) => complete.resolve(value),
        (error: unknown) => complete.resolve(error),
      );
      return result;
    };
    const coordinated = coordinateWorkerPlacementDispatch(
      harness.service,
      createGatewayWorkerDispatchAdmission(),
      undefined,
      {
        placements,
        environments: harness.environments,
        redispatchPlacement: async () => {
          throw new Error("Initial placement expected");
        },
        warn: () => {},
      },
    );
    const prepare = createRequiredWorkerSessionPreparation({
      getConfig: config.getRuntimeConfig,
      dispatch: coordinated,
    });
    const context = createDirectChatContext({
      getRuntimeConfig: config.getRuntimeConfig,
      getClientConnIds: () => new Set([client.connId]),
    });
    context.workerPlacementDispatchService = { ...coordinated, withRequiredSession: prepare };
    context.workerSessionPlacementService = placements;
    await initializeSessionReadContext(context);
    const rpc = async (method: string, params: Record<string, unknown>) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: method, method, params },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond.mock.calls[0]?.[0], JSON.stringify(respond.mock.calls)).toBe(true);
      return respond.mock.calls[0]?.[1];
    };
    try {
      const created = await rpc("sessions.create", {
        key,
        agentId: "main",
        repository: { url: "https://github.com/example/repository" },
      });
      expect(created).toMatchObject({ key, runStarted: false });
      await entered.promise;
      expect(verify).not.toHaveBeenCalled();
      expect(commands).toEqual([]);
      let stop: Promise<unknown> | undefined;
      if (scenario === "policy") {
        policyCurrent = false;
      }
      if (scenario === "caller") {
        client.connect.scopes = [];
      }
      if (scenario === "source") {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: key, storePath },
          { ...entry()!, sessionId: "replacement-session" },
        );
      }
      if (scenario === "stop") {
        // Targeted Stop uses the real controller effect owner after RPC creation settled.
        const target = captureSessionTarget({
          agentId: "main",
          storeScope: storePath,
          sessionKey: key,
        });
        const capture = captureSessionControllerStop({ targets: [target] });
        expect(capture.effects.length + capture.operations.length).toBeGreaterThan(0);
        stop = stopSession({
          source: "client-session",
          capture,
          hookContext: {
            sessionKey: key,
            sessionId: entry()!.sessionId,
            sessionEntry: entry()!,
            commandSource: "gateway:sessions.abort",
          },
        }).completed;
        await stopped.promise;
      }
      resume.resolve();
      const outcome = await complete.promise;
      await stop;
      if (scenario === "allowed") {
        expect(outcome, String(outcome)).toMatchObject({ state: "active" });
        expect(verify).toHaveBeenCalledTimes(1);
        const placement = (
          await placements.readProjection([entry()!.sessionId], { current: true })
        ).placements.get(entry()!.sessionId)!;
        expect(
          await fs.readFile(path.join(placement.remoteWorkspaceDir!, "tracked.txt"), "utf8"),
        ).toBe("pinned source\n");
      } else {
        expect(outcome).toBeInstanceOf(Error);
        expect(verify).not.toHaveBeenCalled();
        expect(commands).toEqual([]);
      }
    } finally {
      resume.resolve();
      await complete.promise;
      catalog.release();
    }
  },
);
