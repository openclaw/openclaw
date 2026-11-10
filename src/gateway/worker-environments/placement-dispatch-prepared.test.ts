import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import * as publicationAvailability from "../github-publication-availability.js";
import { sessionLog } from "../session-log.js";
import type { EnvironmentRecipe } from "./environment-recipe.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { REQUEST } from "./placement-dispatch-test-fixtures.js";
import { prepareRepositoryGitHubIdentity } from "./repository-github-identity.js";
import {
  createPreparedRepositoryNodeFixture,
  createRepositoryNodeFixture,
  createRepositoryPolicySource,
  createManagedRepositoryProfile,
} from "./repository-policy-node.test-support.js";
import * as support from "./service.test-support.js";
import {
  readSessionRepositoryArtifacts,
  stageSessionRepositoryCheckpoint,
} from "./session-repository-checkpoints.js";
import { captureWorkspaceManifest } from "./workspace-manifest-worker.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { requireWorkspaceResultGit } from "./workspace-result-git.js";

// mock-isolation: Workspace startup supplies a synthetic identity without credential discovery.
vi.mock("./repository-github-identity.js", () => ({ prepareRepositoryGitHubIdentity: vi.fn() }));

vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  getRuntimeConfig: () => ({
    gateway: { nodes: { commands: { allow: ["codex.exec-server.stdio.v1"] } } },
  }),
}));

const PREPARATION_KEY = "c".repeat(64);
import { FEATURES, preparedHarness } from "./placement-dispatch-prepared.test-support.js";

function expectBefore(log: string[], before: string, after: string) {
  expect(log.indexOf(before)).toBeLessThan(log.indexOf(after));
}

describe("prepared worker dispatch", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each([false, true])(
    "cold repository checkout uses dispatch admission and revokes its token (revoked=%s)",
    async (revoked) => {
      const repositoryStore = getSessionRepositoryWorkspaceStore();
      const created = await repositoryStore.create({
        agentId: REQUEST.agentId,
        sessionKey: REQUEST.sessionKey,
        url: "https://github.com/example/project.git",
        assertCurrent() {},
      });
      const repository = await repositoryStore.bindBase({
        workspaceId: created.workspaceId,
        expectedRevision: created.revision,
        baseCommit: "a".repeat(40),
        baseManifestHash: "sha256:" + "b".repeat(64),
        assertCurrent() {},
      });
      const { harness, request } = await preparedHarness({
        emptyWorkspace: true,
        repository: { ...repository, baseCommit: "a".repeat(40) },
      });
      const config: OpenClawConfig = {
        tools: {
          github: {
            kind: "app-installation",
            profileId: "ghp_00000000000000000000000000000001",
            app: {
              appId: 101,
              installationId: 202,
              accountId: 303,
              repositories: [{ id: 404, fullName: "example/project" }],
              permissions: { contents: "read" },
              privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
                type: "pkcs8",
                format: "pem",
              }),
              keyVersion: "synthetic-v1",
            },
          },
        },
      };
      setRuntimeConfigSnapshot(config);
      vi.spyOn(publicationAvailability, "currentGitHubPublicationConfig").mockReturnValue(config);
      const native = await vi.importActual<typeof import("./repository-github-identity.js")>(
        "./repository-github-identity.js",
      );
      vi.mocked(prepareRepositoryGitHubIdentity).mockImplementation(
        native.prepareRepositoryGitHubIdentity,
      );
      vi.stubEnv("FACTORY_AUTH_MODE", "github");
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("dispatch revoked");
        }
      };
      const readNativeCredential = vi.fn(async () => {
        await Promise.resolve();
        current = !revoked;
        return undefined;
      });
      const permissions = { contents: "read", metadata: "read" };
      const fetcher = vi.fn<typeof fetch>(async (input, init) => {
        const pathname = new URL(new Request(input).url).pathname;
        if (init?.method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        const bodies: Record<string, unknown> = {
          "/app": { id: 101, slug: "synthetic", permissions },
          "/app/installations/202": {
            id: 202,
            app_id: 101,
            account: { id: 303 },
            suspended_at: null,
            permissions,
          },
          "/users/synthetic%5Bbot%5D": {
            id: 9001,
            login: "synthetic[bot]",
            type: "Bot",
            avatar_url: null,
          },
          "/installation/repositories": {
            total_count: 1,
            repositories: [{ id: 404, full_name: "example/project" }],
          },
          "/app/installations/202/access_tokens": {
            token: "synthetic-dispatch-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            permissions,
          },
        };
        if (!bodies[pathname]) {
          throw new Error("Unexpected fixture endpoint: " + pathname);
        }
        return Response.json(bodies[pathname]);
      });
      vi.stubGlobal("fetch", fetcher);
      const tunnel = vi.mocked(harness.environments.startTunnel);
      const originalTunnel = tunnel.getMockImplementation()!;
      const checkout = vi.fn(async () => {
        throw new Error("Synthetic checkout unavailable");
      });
      tunnel.mockImplementation(async (tunnelRequest) => {
        const handle = await originalTunnel(tunnelRequest);
        handle.syncWorkspace = async (input) => {
          input.authorize?.();
          if (input.source.kind !== "repository") {
            throw new Error("Wrong source");
          }
          expect(input.source.gitToken).toBe("synthetic-dispatch-token");
          return checkout();
        };
        return handle;
      });
      try {
        await expect(
          harness.service.dispatch({ ...request, readNativeCredential }, undefined, assertCurrent),
        ).rejects.toThrow(revoked ? "dispatch revoked" : "Synthetic checkout unavailable");
        expect(readNativeCredential).toHaveBeenCalledOnce();
        expect(checkout).toHaveBeenCalledTimes(revoked ? 0 : 1);
        expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
          revoked ? 0 : 1,
        );
        expect(fetcher.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(
          revoked ? 0 : 1,
        );
        expect(harness.log).not.toContain("activation");
      } finally {
        clearRuntimeConfigSnapshot();
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      }
    },
  );

  function expectUnusedReserve(
    fixture: Pick<Awaited<ReturnType<typeof preparedHarness>>, "harness" | "store" | "ready">,
    environmentId: string,
  ) {
    const { harness, store, ready } = fixture;
    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
    expect(store.getCredential(ready.environmentId)?.sessionId).toBeNull();
    expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
    expect(harness.environments.createWithRequest).toHaveBeenCalledOnce();
    expect(environmentId).toBe(harness.ready.environmentId);
  }

  const lifecycleRecipe: EnvironmentRecipe = {
    source: "devcontainer",
    identity: "8".repeat(40),
    inputs: { ".devcontainer/devcontainer.json": "8".repeat(40) },
    env: {},
    postCreate: ["post-create"],
    postStart: ["post-start"],
  };

  it.each([true, false, "disabled"] as const)(
    "runs admitted lifecycle after sync before activation (reserve=%s)",
    async (reserveMode) => {
      const reserve = reserveMode === true;
      const runSetupScript = reserveMode !== "disabled";
      const { harness, request, ready, store } = await preparedHarness({
        reserve,
        recipe: lifecycleRecipe,
        runSetupScript,
      });
      const previousDiagnostics = areDiagnosticsEnabledForProcess();
      setDiagnosticsEnabledForProcess(true);
      onTestFinished(() => {
        setDiagnosticsEnabledForProcess(previousDiagnostics);
        vi.restoreAllMocks();
      });
      vi.spyOn(sessionLog, "isEnabled").mockReturnValue(true);
      const warn = vi.spyOn(sessionLog, "warn").mockImplementation(() => {
        throw new Error("diagnostic sink unavailable");
      });
      let now = 0;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      const attach = vi.mocked(harness.environments.attachSession);
      const ordinaryAttach = attach.getMockImplementation()!;
      attach.mockImplementation(async (params) => {
        const credential = await ordinaryAttach(params);
        now += 1_200;
        return credential;
      });
      if (!reserve) {
        const provision = vi.mocked(harness.environments.createWithRequest);
        const environment = harness.environments.get(ready.environmentId)!;
        provision.mockImplementation(async () => {
          now += 600;
          return environment;
        });
      }

      const active = await harness.service.dispatch(request);

      const effects = path.join(
        support.testState.root,
        "lifecycle-workspace",
        "lifecycle-effects.txt",
      );
      if (runSetupScript) {
        expect(await fs.readFile(effects, "utf8")).toBe("post-create\npost-start\n");
      } else {
        await expect(fs.readFile(effects)).rejects.toMatchObject({ code: "ENOENT" });
      }
      const phases = [
        "workspace:bind-prepared",
        "sync",
        "lifecycle:post-create",
        "lifecycle:post-start",
        "placement:starting",
        "activation",
      ];
      expect(active.state).toBe("active");
      if (!reserve) {
        expect(active.environmentId).toBe(ready.environmentId);
        expect(store.get(ready.environmentId)?.preparation).toBeNull();
      }
      expect(warn).toHaveBeenCalledWith(
        "slow placement dispatch",
        expect.objectContaining({
          operation: "sessions.dispatch",
          elapsedMs: reserve ? 1_200 : 1_800,
          phaseDurationsMs: expect.objectContaining({
            attach: 1_200,
            ...(!reserve ? { provision: 600 } : {}),
          }),
        }),
      );
      expect(harness.log.filter((phase) => phases.includes(phase))).toEqual(
        phases.filter((phase) => runSetupScript || !phase.startsWith("lifecycle:")),
      );
      const tunnel = await vi.mocked(harness.environments.startTunnel).mock.results[0]!.value;
      expect(tunnel.launchTurn).not.toHaveBeenCalled();
    },
  );

  it("carries prepared repository authority into the provider lifecycle launch", async () => {
    const { harness, request } = await preparedHarness({ recipe: lifecycleRecipe });
    let repositoryCurrent = true;
    const bind = vi.mocked(harness.environments.bindPreparedWorkspace);
    const ordinaryBind = bind.getMockImplementation()!;
    bind.mockImplementation(async (input) => ({
      ...(await ordinaryBind(input)),
      assertCurrent: () => {
        input.assertCurrent();
        if (!repositoryCurrent) {
          throw new Error("Repository identity revoked");
        }
      },
    }));
    const runSetup = vi.fn<NonNullable<typeof harness.environments.runProjectLifecycleCommand>>(
      async (_environmentId, _ownerEpoch, command) => {
        expect(command.workspaceDir).toBe("/worker/workspace");
        expect(command.homeDir).toBe("/worker/home");
        command.assertCurrent();
        await Promise.resolve();
        repositoryCurrent = false;
        command.assertCurrent();
        throw new Error("Repository command must not launch");
      },
    );
    harness.environments.runProjectLifecycleCommand = runSetup;
    await expect(harness.service.dispatch(request)).rejects.toThrow("Repository identity revoked");
    expect(harness.log).not.toContain("lifecycle:post-create");
    expect(harness.log).not.toContain("activation");
  });

  it("fails dispatch before activation when a declared post-binding command fails", async () => {
    const { harness, placements, ready, request } = await preparedHarness({
      recipe: lifecycleRecipe,
      lifecycleFailure: true,
    });

    await expect(harness.service.dispatch(request)).rejects.toThrow("fixture failure");

    expect(harness.log).toContain("lifecycle:post-create");
    expect(harness.log).not.toContain("lifecycle:post-start");
    expect(harness.log).not.toContain("activation");
    expect(placements.get(request.sessionId)?.state).toBe("failed");
    expect(harness.environments.destroy).toHaveBeenCalledWith(ready.environmentId);
  });

  it.each(
    (["worker-turn", "remote-exec"] as const).flatMap((executionMode) =>
      [false, true].map((emptyWorkspace) => ({ executionMode, emptyWorkspace })),
    ),
  )(
    "consumes the existing environment for $executionMode (empty workspace: $emptyWorkspace)",
    async ({ executionMode, emptyWorkspace }) => {
      const { harness, placements, store, ready, request } = await preparedHarness({
        executionMode,
        emptyWorkspace,
      });
      vi.mocked(harness.environments.schedulePreparedRefill).mockImplementation(() => {
        expect(placements.get(request.sessionId)?.state).toBe("active");
        throw new Error("refill scheduling failed");
      });

      const active = await harness.service.dispatch(request);

      expect(active).toMatchObject({
        state: "active",
        environmentId: ready.environmentId,
        executionMode,
      });
      expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
      expect(store.get(ready.environmentId)?.lastActivatedAtMs).toBe(1_000);
      expect(store.getCredential(ready.environmentId)).toMatchObject({
        sessionId: request.sessionId,
        ownerEpoch: active.activeOwnerEpoch,
      });
      if (emptyWorkspace) {
        expect(harness.environments.bindPreparedWorkspace).not.toHaveBeenCalled();
      } else {
        expectBefore(harness.log, "workspace:bind-prepared", "sync");
      }
      expect(harness.environments.schedulePreparedRefill).toHaveBeenCalledWith(ready.environmentId);
      const tunnel = await vi.mocked(harness.environments.startTunnel).mock.results[0]?.value;
      expect(tunnel?.syncWorkspace).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: request.sessionKey,
          source: {
            kind: "local",
            path: "/gateway/workspace",
            ...(emptyWorkspace ? {} : { projectKey: "d".repeat(64) }),
          },
        }),
      );
    },
  );

  it.each(["build", "node", "exec-authority"] as const)(
    "uses the cold path when a candidate's %s proof is stale",
    async (stale) => {
      const { harness, store, ready, request, revokeNode } = await preparedHarness({
        protocolFeatures:
          stale === "exec-authority" ? [WORKER_EXECUTION_CONTEXT_PROTOCOL_FEATURE] : undefined,
      });
      if (stale === "build") {
        const environment = harness.environments.get(ready.environmentId)!;
        vi.mocked(harness.environments.getPreparedCandidates).mockReturnValue([
          {
            ...environment,
            bootstrapReceipt: { ...ready.bootstrapReceipt!, bundleHash: "9".repeat(64) },
          },
        ]);
      } else if (stale === "node") {
        revokeNode();
      }

      const active = await harness.service.dispatch(request);

      expectUnusedReserve({ harness, store, ready }, active.environmentId);
      expect(active.environmentId).not.toBe(ready.environmentId);
    },
  );

  it.each([
    { executionMode: "worker-turn", reconnect: false },
    { executionMode: "remote-exec", reconnect: false },
    { executionMode: "worker-turn", reconnect: true },
    { executionMode: "remote-exec", reconnect: true },
  ] as const)(
    "keeps a $executionMode reserve unconsumed after session hosting is disabled (reconnect=$reconnect)",
    async ({ executionMode, reconnect }) => {
      const fixture = await preparedHarness({
        executionMode,
      });
      const { harness, request, setHostingAvailable } = fixture;
      setHostingAvailable(false, reconnect);

      const active = await harness.service.dispatch(request);

      expectUnusedReserve(fixture, active.environmentId);
    },
  );

  it.each(["worker-turn", "remote-exec"] as const)(
    "does not consume a %s reserve when session hosting is disabled during admission",
    async (executionMode) => {
      const fixture = await preparedHarness({ executionMode });
      const { harness, request, transport, resolveAvailability, setHostingAvailable } = fixture;
      const admitted = createDeferred();
      const release = createDeferred();
      resolveAvailability.mockImplementationOnce(async () => {
        const [node] = await transport.listCurrentNodes();
        admitted.resolve();
        await release.promise;
        return { available: true, node };
      });
      const dispatch = harness.service.dispatch(request);
      try {
        await admitted.promise;
        setHostingAvailable(false);
        release.resolve();
        const active = await dispatch;

        expectUnusedReserve(fixture, active.environmentId);
      } finally {
        release.resolve();
        await dispatch;
      }
    },
  );

  it("does not mint attachment authority after request revocation during build validation", async () => {
    const { harness, store, ready, request } = await preparedHarness();
    let authorized = true;
    vi.mocked(support.testState.prepareInstallation).mockImplementation(async () => {
      authorized = false;
      return { ...support.BUNDLE_ARTIFACT, protocolFeatures: FEATURES };
    });

    await expect(
      harness.service.dispatch(request, undefined, () => {
        if (!authorized) {
          throw new Error("request revoked");
        }
      }),
    ).rejects.toThrow("request revoked");

    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
    expect(harness.environments.startTunnel).not.toHaveBeenCalled();
    expect(harness.environments.destroy).toHaveBeenCalledWith(ready.environmentId);
  });

  it("rejects direct attachment without the prepared placement reservation", async () => {
    const { store, workerService, ready, request } = await preparedHarness();

    await expect(
      workerService.attachSession({
        environmentId: ready.environmentId,
        ownerEpoch: ready.ownerEpoch,
        sessionId: request.sessionId,
      }),
    ).rejects.toThrow("placement reservation");

    expect(store.get(ready.environmentId)).toMatchObject({
      state: "ready",
      preparation: { consumedAtMs: null },
    });
    expect(store.getCredential(ready.environmentId)?.sessionId).toBeNull();
  });

  it("fences a profile change after node eligibility before consuming its reserve", async () => {
    const { harness, store, ready, request } = await preparedHarness();
    vi.mocked(harness.environments.assertPreparedIntentCurrent)
      .mockImplementationOnce(() => {})
      .mockImplementation(() => {
        throw new Error("profile changed");
      });

    await expect(harness.service.dispatch(request)).rejects.toThrow("profile changed");

    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBeNull();
    expect(harness.environments.attachSession).not.toHaveBeenCalled();
    expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
  });

  it("fences workspace upload when node authority closes during prepared binding", async () => {
    const { harness, store, ready, request, revokeNode } = await preparedHarness();
    const bind = vi.mocked(harness.environments.bindPreparedWorkspace);
    const ordinaryBind = bind.getMockImplementation()!;
    bind.mockImplementation(async (binding) => {
      const prepared = await ordinaryBind(binding);
      revokeNode();
      return prepared;
    });

    await expect(harness.service.dispatch(request)).rejects.toThrow("node authority");

    expect(harness.log).not.toContain("sync");
    expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
    expect(harness.environments.destroy).toHaveBeenCalledWith(ready.environmentId);
    expect(harness.environments.schedulePreparedRefill).not.toHaveBeenCalled();
  });
  it.each([
    ["allowed", undefined, true],
    ["profile-disabled", false, true],
    ["non-admin", undefined, false],
    ["revoked-before-setup", undefined, true],
  ] as const)(
    "enforces %s setup policy through real runtime-image checkout commands",
    async (scenario, runSetupScript, admin) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
      onTestFinished(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
      });
      const nativeIdentity = await vi.importActual<
        typeof import("./repository-github-identity.js")
      >("./repository-github-identity.js");
      vi.mocked(prepareRepositoryGitHubIdentity).mockImplementation(
        nativeIdentity.prepareRepositoryGitHubIdentity,
      );
      const profileId = "ghp_77777777777777777777777777777777";
      const config: OpenClawConfig = {
        ...support.testState.config,
        tools: { github: { profileId } },
      };
      setRuntimeConfigSnapshot(config);
      vi.spyOn(publicationAvailability, "currentGitHubPublicationConfig").mockReturnValue(config);
      await createManagedRepositoryProfile({
        stateDir: support.testState.root,
        agentId: REQUEST.agentId,
        profileId,
        token: "synthetic-setup-token",
      });
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(JSON.stringify({ id: 777, login: "setup-fixture", type: "User" }), {
            status: 200,
            headers: { "Content-Type": "application/json", "x-oauth-scopes": "repo" },
          }),
      );
      const root = path.join(support.testState.root, `checkout-${scenario}`);
      const seed = path.join(root, "seed");
      const nodeHome = path.join(root, "node");
      await fs.mkdir(path.join(seed, ".openclaw"), { recursive: true });
      await fs.writeFile(path.join(seed, "tracked.txt"), "source\n");
      const effectFile = path.join(root, "setup-effect.txt");
      await fs.writeFile(
        path.join(seed, ".openclaw", "worktree-setup.sh"),
        `#!/bin/sh
printf executed > ${JSON.stringify(effectFile)}
`,
        { mode: 0o755 },
      );
      await requireWorkspaceResultGit(seed, ["init", "-b", "main"]);
      await requireWorkspaceResultGit(seed, ["add", "."]);
      await requireWorkspaceResultGit(seed, [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "source",
      ]);
      const baseCommit = await requireWorkspaceResultGit(seed, ["rev-parse", "HEAD"]);
      const repositoryStore = getSessionRepositoryWorkspaceStore();
      const accepted = await repositoryStore.create({
        agentId: REQUEST.agentId,
        sessionKey: REQUEST.sessionKey,
        url: "https://github.com/example/runtime-checkout",
        requestedRef: "main",
        runSetupScript: true,
        assertCurrent: () => {},
      });
      const { harness, request, ready, store } = await preparedHarness({
        emptyWorkspace: true,
        runSetupScript,
        repository: { ...accepted, baseCommit },
      });
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("Setup operator revoked");
        }
      };
      const identity = {
        gatewayNamespace: "checkout-gateway",
        environmentId: ready.environmentId,
      };
      const { runtime, workspaceTransfer, gatewayUrl } = await createRepositoryNodeFixture({
        nodeHome,
        store,
      });
      const commands: string[] = [];
      const ordinaryTunnel = vi.mocked(harness.environments.startTunnel).getMockImplementation()!;
      vi.mocked(harness.environments.startTunnel).mockImplementation(async (params) => {
        const tunnel = await ordinaryTunnel(params);
        const actions = createNodeWorkerWorkspaceActions({
          environmentId: ready.environmentId,
          ownerEpoch: params.ownerEpoch,
          sessionId: request.sessionId,
          ownerSignal: new AbortController().signal,
          isOwnerCurrent: () => current,
          workspaceTransfer,
          runWorkspaceCommand: async (command) => {
            const setup = command.argv.some((arg) => arg.includes("worktree-setup.sh"));
            if (setup && scenario === "revoked-before-setup") {
              current = false;
            }
            command.assertCurrent?.();
            commands.push(setup ? "setup" : command.argv[0]!);
            const argv = command.argv.map((arg) =>
              arg === accepted.url ? pathToFileURL(seed).href : arg,
            );
            return runtime.exec(
              {
                ...identity,
                argv,
                sessionId: request.sessionId,
                sessionKey: command.sessionKey,
                generation: params.ownerEpoch,
                input: command.input,
                timeoutMs: command.timeoutMs,
                resetWorkspace: command.resetWorkspace,
                seed: command.seed,
                transfer: command.transfer,
              },
              undefined,
              { url: gatewayUrl },
            );
          },
        });
        vi.spyOn(tunnel, "syncWorkspace").mockImplementation(actions.syncWorkspace);
        vi.spyOn(tunnel, "reconcileWorkspace").mockImplementation(actions.reconcileWorkspace);
        return tunnel;
      });
      const dispatch = harness.service.dispatch(
        {
          ...request,
          runSetupScript: admin,
        },
        undefined,
        assertCurrent,
      );
      if (scenario === "non-admin" || scenario === "revoked-before-setup") {
        await expect(dispatch).rejects.toThrow(
          scenario === "non-admin" ? "administrator" : /revoked|authority|owner/i,
        );
      } else {
        await dispatch;
      }
      if (scenario === "allowed") {
        expect(await fs.readFile(effectFile, "utf8")).toBe("executed");
      } else {
        await expect(fs.readFile(effectFile)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      expect(commands.filter((command) => command === "setup")).toHaveLength(
        scenario === "allowed" ? 1 : 0,
      );
    },
  );

  it.each([
    ["allowed", true],
    ["allowed", false],
    ["forbidden", false],
    ["revoked-after-checkpoint", false],
    ["revoked-before-command", false],
  ] as const)(
    "checks %s repository policy at real prepared Git/checkpoint effects (setup=%s)",
    async (scenario, runSetupScript) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
      onTestFinished(() => {
        vi.unstubAllEnvs();
      });
      vi.mocked(prepareRepositoryGitHubIdentity).mockClear();
      const nodeHome = path.join(support.testState.root, "policy-node");
      const stagingRoot = path.join(
        nodeHome,
        ".openclaw-worker",
        "prepared",
        "policy-gateway",
        "a".repeat(64),
        "workspace",
      );
      const { baseCommit, base } = await createRepositoryPolicySource(stagingRoot);
      await fs.writeFile(path.join(stagingRoot, "session.txt"), "accepted session change\n");
      const current = await captureWorkspaceManifest({ root: stagingRoot, baseCommit });
      const repositoryStore = getSessionRepositoryWorkspaceStore();
      const created = await repositoryStore.create({
        agentId: REQUEST.agentId,
        sessionKey: REQUEST.sessionKey,
        url: "https://github.com/example/project.git",
        requestedRef: "refs/heads/main",
        runSetupScript: true,
        assertCurrent: () => {},
      });
      const pinned = await repositoryStore.bindBase({
        workspaceId: created.workspaceId,
        expectedRevision: created.revision,
        baseCommit,
        baseManifestHash: base.manifestRef,
        assertCurrent: () => {},
      });
      const staged = await stageSessionRepositoryCheckpoint({
        workspaceId: pinned.workspaceId,
        expectedRevision: pinned.revision,
        stagingRoot,
        baseManifestRaw: serializeWorkerWorkspaceManifest(base.manifest),
        currentManifestRaw: serializeWorkerWorkspaceManifest(current.manifest),
        baseManifestRef: base.manifestRef,
        currentManifestRef: current.manifestRef,
        assertCurrent: () => {},
      });
      try {
        await staged.publish();
      } finally {
        await staged.discard();
      }
      const accepted = (await repositoryStore.get(created.workspaceId))!;
      const boundWorkspace = {
        workspaceDir: stagingRoot,
        sourceManifestRef: base.manifestRef,
        preparedManifestRef: base.manifestRef,
      };
      const { harness, store, ready, request } = await preparedHarness({
        repository: { ...accepted, baseCommit },
        boundWorkspace,
        ...(runSetupScript ? { recipe: lifecycleRecipe } : {}),
      });
      await fs.rm(path.join(stagingRoot, "session.txt"));
      await requireWorkspaceResultGit(stagingRoot, ["checkout", "--detach", baseCommit]);
      await requireWorkspaceResultGit(stagingRoot, ["remote", "add", "origin", accepted.url]);
      const nodeIdentity = {
        gatewayNamespace: "policy-gateway",
        environmentId: ready.environmentId,
        preparationKey: PREPARATION_KEY,
        cacheKey: "a".repeat(64),
      };
      const { runtime, workspaceTransfer, gatewayUrl } = await createPreparedRepositoryNodeFixture({
        nodeHome,
        workspaceDir: stagingRoot,
        base,
        store,
        identity: nodeIdentity,
      });
      let policyCurrent = scenario !== "forbidden";
      const assertRepositoryCurrent = () => {
        if (!policyCurrent) {
          throw new Error("repository policy revoked");
        }
      };
      const bind = vi.mocked(harness.environments.bindPreparedWorkspace);
      const ordinaryBind = bind.getMockImplementation()!;
      bind.mockImplementation(async (input) => {
        assertRepositoryCurrent();
        const prepared = await ordinaryBind(input);
        await runtime.prepare({
          action: "bind",
          ...nodeIdentity,
          sessionId: input.sessionId,
          sessionKey: input.sessionKey,
          ownerEpoch: input.ownerEpoch,
        });
        assertRepositoryCurrent();
        return {
          ...prepared,
          assertCurrent: () => {
            input.assertCurrent();
            assertRepositoryCurrent();
          },
        };
      });
      let effects = 0;
      const startTunnel = vi.mocked(harness.environments.startTunnel);
      const ordinaryTunnel = startTunnel.getMockImplementation()!;
      startTunnel.mockImplementation(async (params) => {
        const tunnel = await ordinaryTunnel(params);
        vi.spyOn(tunnel, "syncWorkspace").mockImplementation(async (sync) => {
          harness.log.push("sync");
          if (sync.source.kind !== "repository" || !sync.source.checkpoint) {
            throw new Error("Missing accepted checkpoint");
          }
          expect(
            await fs.readFile(path.join(sync.source.checkpoint.stagingRoot, "session.txt"), "utf8"),
          ).toBe("accepted session change\n");
          if (scenario === "revoked-after-checkpoint") {
            policyCurrent = false;
          }
          const actions = createNodeWorkerWorkspaceActions({
            environmentId: ready.environmentId,
            ownerEpoch: params.ownerEpoch,
            sessionId: request.sessionId,
            ownerSignal: new AbortController().signal,
            isOwnerCurrent: () => true,
            workspaceTransfer,
            runWorkspaceCommand: async (command) => {
              if (scenario === "revoked-before-command" && effects === 0) {
                await Promise.resolve();
                policyCurrent = false;
              }
              command.assertCurrent?.();
              effects++;
              return await runtime.exec(
                {
                  ...nodeIdentity,
                  sessionId: request.sessionId,
                  sessionKey: command.sessionKey,
                  generation: params.ownerEpoch,
                  argv: [...command.argv],
                  input: command.input,
                  timeoutMs: command.timeoutMs,
                  resetWorkspace: command.resetWorkspace,
                  seed: command.seed,
                  transfer: command.transfer,
                },
                undefined,
                { url: gatewayUrl },
              );
            },
          });
          return await actions.syncWorkspace(sync);
        });
        return tunnel;
      });
      const dispatch = harness.service.dispatch({ ...request, runSetupScript });
      if (scenario !== "allowed") {
        await expect(dispatch).rejects.toThrow("repository policy revoked");
        expect(effects).toBe(0);
        expect(prepareRepositoryGitHubIdentity).not.toHaveBeenCalled();
        expect(await requireWorkspaceResultGit(stagingRoot, ["branch", "--show-current"])).toBe("");
        await expect(
          fs.readFile(path.join(stagingRoot, "session.txt"), "utf8"),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(await repositoryStore.get(accepted.workspaceId)).toEqual(accepted);
        return;
      }
      const active = await dispatch;
      expect(effects).toBeGreaterThan(0);
      expect(prepareRepositoryGitHubIdentity).not.toHaveBeenCalled();
      expect(await requireWorkspaceResultGit(stagingRoot, ["branch", "--show-current"])).toBe(
        accepted.branch,
      );
      expect(await fs.readFile(path.join(stagingRoot, "session.txt"), "utf8")).toBe(
        "accepted session change\n",
      );

      expect(active).toMatchObject({
        state: "active",
        environmentId: ready.environmentId,
        remoteWorkspaceDir: boundWorkspace.workspaceDir,
        workspaceBaseManifestRef: current.manifestRef,
      });
      expect(harness.environments.createWithRequest).not.toHaveBeenCalled();
      expect(store.get(ready.environmentId)?.preparation?.consumedAtMs).toBe(1_000);
      expectBefore(harness.log, "workspace:bind-prepared", "sync");
      expect(await repositoryStore.get(accepted.workspaceId)).toEqual(accepted);
      if (runSetupScript) {
        expectBefore(harness.log, "sync", "lifecycle:post-create");
        expectBefore(harness.log, "lifecycle:post-start", "placement:starting");
      }
      const checkpoint = await readSessionRepositoryArtifacts({
        workspaceId: accepted.workspaceId,
        assertCurrent: () => {},
      });
      expect(checkpoint.currentManifestRef).toBe(current.manifestRef);
      expect(harness.environments.schedulePreparedRefill).toHaveBeenCalledWith(ready.environmentId);
      const tunnel = await startTunnel.mock.results[0]!.value;
      expect(tunnel.quiesceWorkspace).not.toHaveBeenCalled();
      expect(tunnel.reconcileWorkspace).not.toHaveBeenCalled();
    },
  );
});
