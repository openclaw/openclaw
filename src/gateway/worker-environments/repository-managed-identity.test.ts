import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { clearGitHubCredentialVerificationCache } from "../../agents/github-oauth-client.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { createPluginRecord } from "../../plugins/loader-records.js";
import { getPluginInstance } from "../../plugins/plugin-instance-scope.js";
import { createTestPluginRegistry } from "../../plugins/registry-runtime.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import * as githubOAuthLifecycle from "../github-oauth-lifecycle.js";
import {
  repositoryDispatchCredentialReader,
  withRepositoryChatDispatch,
} from "../repository-dispatch.js";
import type { GatewayClient } from "../server-methods/client-types.js";
import { createGatewayWorkerDispatchAdmission } from "../server-worker-placement-dispatch-admission.js";
import { createRequiredWorkerSessionPreparation } from "../server-worker-required-profile.js";
import { gatewayConnect, gatewayProfile } from "../server/client-fixtures.test-support.js";
import { createNodeWorkerRepositoryPreparation } from "./node-worker-repository-preparation.js";
import { coordinateWorkerPlacementDispatch } from "./placement-dispatch-coordinator.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { createHarness } from "./placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { prepareRepositoryGitHubIdentity } from "./repository-github-identity.js";
import {
  createManagedRepositoryProfile,
  createRepositoryPolicySource,
} from "./repository-policy-node.test-support.js";
import * as support from "./service.test-support.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";

support.setupWorkerEnvironmentServiceSuite((_config, root) => {
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
});
afterEach(() => {
  resetPluginRuntimeStateForTest();
  clearGitHubCredentialVerificationCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

for (const kind of ["pat", "oauth", "native"] as const) {
  const scenarios = [
    "allowed",
    "denied",
    "missing-admission",
    "unadmitted-reader",
    "selected-during-refresh",
    "revoked-during-refresh",
    "revoked-after-seed",
    "caller-revoked-after-seed",
    "disposed-after-seed",
    "no-integration",
  ] as const;
  const cases =
    kind === "native"
      ? (["allowed", "revoked-after-seed"] as const)
      : kind === "pat"
        ? ([
            ...scenarios,
            "required",
            "required-queued",
            "required-no-integration",
            "required-no-admission",
            "required-stop-after-seed",
            "required-source-after-seed",
          ] as const)
        : scenarios;
  it.each(cases)("admits " + kind + " repository dispatch: %s", async (scenario) => {
    const root = support.testState.root;
    const origin = path.join(root, "origin");
    const { baseCommit, base } = await createRepositoryPolicySource(origin);
    const profileId = "ghp_88888888888888888888888888888888";
    const required = scenario.startsWith("required");
    const stopped = new AbortController();
    const sessionScope = { agentId: REQUEST.agentId, sessionKey: REQUEST.sessionKey };
    const config = {
      agents: { entries: { main: { workspace: root } } },
      ...(required
        ? {
            cloudWorkers: {
              requiredProfile: REQUEST.profileId,
              profiles: { development: { provider: "fake", settings: {} } },
            },
          }
        : {}),
      ...(kind === "native"
        ? {}
        : { tools: { github: { profileId, ...(kind === "oauth" ? { kind } : {}) } } }),
      ...(scenario === "no-integration" ||
      scenario === "required-no-integration" ||
      scenario === "selected-during-refresh" ||
      scenario === "caller-revoked-after-seed"
        ? {}
        : { gateway: { repositoryIntegration: "repository-policy" } }),
    };
    await createManagedRepositoryProfile({
      agentId: "main",
      profileId,
      stateDir: root,
      token: "synthetic-managed-credential",
    });
    const profile = ensureProfileForEmail("managed-policy@example.invalid");
    support.testState.releaseTurnOwners.push((await prepareUserProfileCatalog()).release);
    const builder = createTestPluginRegistry();
    const record = createPluginRecord({
      id: "repository-policy",
      source: "synthetic-policy",
      origin: "workspace",
      enabled: true,
      configSchema: false,
    });
    record.contracts = { repositoryIntegrations: ["repository"] };
    builder.registry.plugins.push(record);
    const api = builder.createApi(record, { config });
    setActivePluginRegistry(builder.registry);
    setRuntimeConfigSnapshot(config);
    let policyCurrent = scenario !== "denied";
    let policyCalls = 0;
    const assertPolicyCurrent = () => {
      if (!policyCurrent) {
        throw new Error("Repository policy denied");
      }
    };
    const nativeRead = vi.fn(async () => {
      if (kind === "native") {
        return "synthetic-managed-credential";
      }
      throw new Error("Managed credentials must remain with the native managed-profile owner");
    });
    api.registerRepositoryIntegration({
      version: 1,
      // This fixture exercises source preparation; image-only claims are covered separately.
      preparedCapacity: "repository",
      resolveConnectionIdentity: () => undefined,
      async withIdentity(context, run) {
        policyCalls++;
        context.assertCurrent();
        assertPolicyCurrent();
        return await run({
          env: context.env,
          readNativeCredential: nativeRead,
          assertCurrent: assertPolicyCurrent,
        });
      },
    });
    const client: GatewayClient = {
      connId: "managed-policy-connection",
      authenticatedUserProfile: gatewayProfile(profile.id),
      connect: gatewayConnect(["operator.write"]),
      internal: { authenticatedOperator: true },
    };
    const readNativeCredential = required
      ? undefined
      : repositoryDispatchCredentialReader({
          client,
          agentId: "main",
          sessionId: REQUEST.sessionId,
          sessionKey: REQUEST.sessionKey,
          requestDigest: "managed-checkout",
          assertCurrent() {},
        });
    const verifyCredential = vi.fn(async () =>
      Response.json({ id: 202, login: "managed-fixture" }),
    );
    vi.stubGlobal("fetch", verifyCredential);
    const refresh = vi
      .spyOn(githubOAuthLifecycle, "requestCurrentGitHubOAuthRefresh")
      .mockImplementation(async () => {
        await Promise.resolve();
        if (scenario === "revoked-during-refresh") {
          policyCurrent = false;
        }
        if (scenario === "selected-during-refresh") {
          setRuntimeConfigSnapshot({ ...config, gateway: { repositoryIntegration: record.id } });
        }
      });
    const commands: string[] = [];
    const nodeHome = path.join(root, "node-home");
    await fs.mkdir(nodeHome, { recursive: true });
    const runtime = new NodeWorkerWorkspaceRuntime({
      root: path.join(root, "node-state"),
      env: { PATH: process.env.PATH, HOME: nodeHome },
    });
    let callerCurrent = true;
    const assertCallerCurrent = () => {
      if (!callerCurrent) {
        throw new Error("Worker caller retired");
      }
    };
    const store = getSessionRepositoryWorkspaceStore();
    const repository = await store.create({
      ...REQUEST,
      url: "https://github.com/example/repository",
      assertCurrent: assertCallerCurrent,
    });
    if (required) {
      await upsertSessionEntryCore(sessionScope, {
        sessionId: REQUEST.sessionId,
        updatedAt: Date.now(),
        repositoryWorkspaceId: repository.workspaceId,
      });
    }
    const placements = createWorkerSessionPlacementStore({ database: support.testState.stateDb });
    const harness = await createHarness(support.testState.stateDb, placements, {
      requiresNodeEnrollment: true,
      resolveWorkspace: async () => ({ kind: "repository", repository }),
    });
    const originalIntent = harness.environments.prepareProjectIntent;
    let retainedIdentity: Awaited<ReturnType<typeof prepareRepositoryGitHubIdentity>> | undefined;
    harness.environments.prepareProjectIntent = async (workerProfileId, request) => {
      retainedIdentity = await prepareRepositoryGitHubIdentity("main", request!.assertCurrent!, {
        readNativeCredential: request?.readNativeCredential,
        repositoryUrl: repository.url,
      });
      return originalIntent(workerProfileId, request);
    };
    // Only allocation and tunnel transport are synthetic; Git, admission, checkpoint, and placement owners run normally.
    const originalTunnel = harness.environments.startTunnel;
    harness.environments.startTunnel = async (request) => ({
      ...(await originalTunnel(request)),
      syncWorkspace: async (input) => {
        if (input.source.kind !== "repository") {
          throw new Error("Expected repository");
        }
        expect(input.source.gitToken).toBe("synthetic-managed-credential");
        const preparation = createNodeWorkerRepositoryPreparation(async (command) => {
          command.assertCurrent?.();
          commands.push(command.seed ? "seed" : command.argv.includes("clone") ? "clone" : "git");
          const result = await runtime.exec({
            gatewayNamespace: "managed-policy",
            environmentId: "worker",
            sessionId: REQUEST.sessionId,
            generation: 1,
            argv: [...command.argv],
            input: command.input,
            seed: command.seed,
            resetWorkspace: command.resetWorkspace,
            timeoutMs: command.timeoutMs,
          });
          if (command.seed?.action === "apply") {
            if (scenario === "required-stop-after-seed") {
              stopped.abort(new Error("Stop required dispatch"));
            }
            if (scenario === "required-source-after-seed") {
              await upsertSessionEntryCore(sessionScope, {
                sessionId: "replacement-session",
                updatedAt: Date.now(),
                repositoryWorkspaceId: repository.workspaceId,
              });
            }
            if (scenario === "revoked-after-seed") {
              policyCurrent = false;
            }
            if (scenario === "caller-revoked-after-seed") {
              callerCurrent = false;
            }
            if (scenario === "disposed-after-seed") {
              await getPluginInstance(record)!.dispose();
            }
          }
          return result;
        }, input.authorize!);
        const prepared = await preparation.prepareRepository({
          origin: pathToFileURL(origin).href,
          commit: baseCommit,
          gitToken: input.source.gitToken,
        });
        if (prepared.kind !== "prepared") {
          throw new Error("Managed checkout failed");
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
    let taskCalls = 0;
    const checkout = async () => {
      if (required) {
        const settled = createDeferredCore();
        const coordinated = coordinateWorkerPlacementDispatch(
          harness.service,
          createGatewayWorkerDispatchAdmission(),
          undefined,
          {
            placements,
            environments: harness.environments,
            redispatchPlacement: async () => {
              throw new Error("Expected initial placement");
            },
            warn: () => {},
          },
        );
        const prepare = createRequiredWorkerSessionPreparation({
          getConfig: () => config,
          dispatch: coordinated,
        });
        const run = async () => {
          await prepare(
            { ...sessionScope, sessionId: REQUEST.sessionId },
            async (assertCurrent) => {
              assertCurrent();
              taskCalls++;
            },
            assertCallerCurrent,
            stopped.signal,
            scenario === "required-queued"
              ? { waitForReady: false, retainDispatch: () => () => settled.resolve() }
              : undefined,
          );
          if (scenario === "required-queued") {
            await settled.promise;
          }
          const placement = (
            await placements.readProjection([REQUEST.sessionId], { current: true })
          ).placements.get(REQUEST.sessionId);
          expect(placement).toMatchObject({ state: "active" });
          if (!placement) {
            throw new Error("Required placement missing");
          }
          return placement;
        };
        return scenario === "required-no-admission"
          ? run()
          : withRepositoryChatDispatch(
              {
                client,
                ...sessionScope,
                getSessionId: () => REQUEST.sessionId,
                runId: "required-turn",
                assertCurrent: assertCallerCurrent,
              },
              run,
            );
      }
      return harness.service.dispatch(
        {
          ...REQUEST,
          readNativeCredential:
            scenario === "missing-admission"
              ? undefined
              : scenario === "unadmitted-reader"
                ? nativeRead
                : readNativeCredential,
        },
        undefined,
        assertCallerCurrent,
      );
    };
    if (
      scenario === "allowed" ||
      scenario === "no-integration" ||
      scenario === "required" ||
      scenario === "required-queued" ||
      scenario === "required-no-integration"
    ) {
      const result = await checkout();
      expect(result.state).toBe("active");
      const retiredEffect = path.join(root, "retired-effect");
      await expect(
        retainedIdentity!.start(() => fs.writeFile(retiredEffect, "must not be written")),
      ).rejects.toThrow("released");
      await expect(fs.stat(retiredEffect)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(path.join(result.remoteWorkspaceDir!, "tracked.txt"), "utf8")).toBe(
        "pinned source\n",
      );
      expect(
        await fs.readFile(path.join(result.remoteWorkspaceDir!, ".git", "config"), "utf8"),
      ).not.toContain("synthetic-managed-credential");
      expect(policyCalls > 0).toBe(!scenario.endsWith("no-integration"));
    } else {
      let rejected = false;
      try {
        await checkout();
      } catch {
        rejected = true;
      }
      expect({ rejected, commands }).toEqual({
        rejected: true,
        commands: scenario.endsWith("after-seed") ? ["seed"] : [],
      });
      if (
        scenario === "denied" ||
        scenario === "missing-admission" ||
        scenario === "unadmitted-reader" ||
        scenario === "required-no-admission"
      ) {
        expect(refresh).not.toHaveBeenCalled();
      }
      if (!scenario.endsWith("after-seed")) {
        expect(verifyCredential).not.toHaveBeenCalled();
      }
    }
    if (required) {
      expect(taskCalls).toBe(
        scenario === "required" ||
          scenario === "required-queued" ||
          scenario === "required-no-integration"
          ? 1
          : 0,
      );
    }
    expect(nativeRead.mock.calls.length > 0).toBe(kind === "native");
  });
}
