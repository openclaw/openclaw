import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { createInfoWarnErrorLogger } from "../../test/helpers/mock-logger.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
  prepareRuntimeAuthProfileStoreSnapshots,
} from "../agents/auth-profiles/runtime-snapshots.js";
import { clearFinishedSessionsForScopes } from "../agents/bash-process-registry.js";
import { runExecProcess, type ExecProcessHandle } from "../agents/bash-tools.exec-runtime.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resetGatewayRestartStateForInProcessRestart,
  setGatewayRestartPolicy,
} from "../infra/restart.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createEmptyRuntimeWebToolsMetadata } from "../secrets/runtime-fast-path.js";
import { clearSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createChannelManager } from "./server-channels.js";
import { readGatewayRequestMutationAuthority } from "./server-methods/session-mutation-guards.js";
import { createContext as createGatewayTestContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  createDefaultGatewayReloadState,
  createDirectConfigWriteFixture,
  createConfigWriteNotification,
  createTestConfigRevisionProjector,
  publishConfigWrite,
} from "./server-reload-handlers.config.test-support.js";
import { startManagedGatewayConfigReloader } from "./server-reload-managed.js";
import { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import { createTestRuntimeSecretsActivator } from "./server-startup-config.test-support.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { disconnectDisallowedGatewayPolicyClients } from "./server/ws-origin-policy.js";

// A write that lands while the previous reload finishes its tail is re-armed from that reload's
// finally, after a single zero-delay tick has run. Zero-delay ticks never move the fake clock.
async function tickUntilSettled(operation: Promise<unknown>): Promise<void> {
  const settled = operation.then(
    () => true,
    () => true,
  );
  while (!(await Promise.race([settled, Promise.resolve(false)]))) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

let registrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
const registry = createEmptyPluginRegistry();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  registrySnapshot = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(registry);
  resetGatewayRestartStateForInProcessRestart();
  resetGatewayWorkAdmission();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  clearSecretsRuntimeSnapshot();
  clearRuntimeConfigSnapshot();
  restoreActivePluginRegistrySnapshot(registrySnapshot);
  resetGatewayRestartStateForInProcessRestart();
  setGatewayRestartPolicy({ allowExternal: false });
  resetGatewayWorkAdmission();
});

it("keeps unrelated identity reloads out of retained operator and delegated run authority", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const effectDir = tempDirs.make("openclaw-identity-scope-effects-");
    const effectScript = path.join(effectDir, "effect.cjs");
    await fs.writeFile(
      effectScript,
      'require("node:fs").writeFileSync(process.argv[2], "accepted effect");',
    );
    const processes: ExecProcessHandle[] = [];
    const releaseEffects: Array<() => void> = [];
    const pendingEffects: Promise<unknown>[] = [];
    const identity = "retained@example.test";
    const profile = ensureProfileForEmail(identity);
    const initialConfig: OpenClawConfig = {
      agents: { entries: { main: {} } },
      gateway: {
        auth: {
          identityScopes: {
            [identity]: ["operator.write", "operator.read"],
            "other@example.test": ["operator.read"],
          },
        },
      },
    };
    setRuntimeConfigSnapshot(initialConfig);
    const fixture = createDirectConfigWriteFixture(initialConfig);
    const context = createGatewayTestContext();
    const close = vi.fn();
    const client = {
      ...createOperatorWsClient({ socket: { close }, scopes: ["operator.write", "operator.read"] }),
      authenticatedUserId: identity,
      authenticatedUserProfile: {
        profileId: profile.id,
        displayName: null,
        hasAvatar: false,
        avatarRevision: "1",
        updatedAt: 1,
      },
      authPolicy: captureGatewayAuthPolicy(initialConfig, {
        role: "operator",
        verifiedIdentity: identity,
      }),
    };
    const generation = new SharedGatewaySessionGenerationState({
      current: undefined,
      required: null,
    });
    let state = createDefaultGatewayReloadState();
    const channelManager = createChannelManager({
      scheduler: createTestGatewayScheduler(),
      getRuntimeConfig: () => initialConfig,
      getPluginRegistry: () => registry,
      channelLogs: {},
      channelRuntimeEnvs: {},
    });
    const log = createInfoWarnErrorLogger();
    const requestRecoveryRestart = vi.fn(() => ({ status: "emitted" as const }));
    const reloader = startManagedGatewayConfigReloader({
      scheduler: createTestGatewayScheduler("fake-timers"),
      getPluginRegistry: () => registry,
      configRevisionProjector: createTestConfigRevisionProjector(),
      minimalTestGateway: false,
      initialConfig,
      initialCompareConfig: initialConfig,
      initialSnapshotRawHash: null,
      initialAuthoredConfig: {},
      initialSnapshotValid: true,
      initialSnapshotIssues: [],
      initialPluginInstallRecords: {},
      watchPath: "/tmp/openclaw.json",
      promoteSnapshot: async () => true,
      deps: {},
      broadcast: vi.fn(),
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      channelManager,
      startChannel: channelManager.startChannel,
      stopChannel: channelManager.stopChannel,
      reloadPlugins: async () => {
        throw new Error("Unexpected plugin reload for identity scopes");
      },
      logHooks: log,
      logChannels: log,
      logCron: log,
      logReload: log,
      cronReconciliation: { arm: () => ({ complete: async () => {} }), invalidate: vi.fn() },
      resolveSharedGatewaySessionGenerationForConfig: () => undefined,
      sharedGatewaySessionGenerationState: generation,
      clients: [client],
      prepareTerminalConfig: vi.fn(),
      reconcileRuntimePolicy: (config) =>
        disconnectDisallowedGatewayPolicyClients([client], config),
      commitRuntimePolicy: vi.fn(),
      acceptTerminalConfig: vi.fn(),
      readSnapshot: fixture.readSnapshot,
      subscribeToWrites: fixture.subscribeToWrites,
      resolveGatewayContext: () => context,
      activateRuntimeSecrets: createTestRuntimeSecretsActivator(async ({ config }) => ({
        sourceConfig: config,
        config,
        authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
        authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
        warnings: [],
        webTools: createEmptyRuntimeWebToolsMetadata(),
        authStores: prepareRuntimeAuthProfileStoreSnapshots([]),
      })),
      requestRecoveryRestart,
    });
    const captures: NonNullable<Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>>[] =
      [];
    let delegated: Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>;
    const guards: ReturnType<typeof readGatewayRequestMutationAuthority>[] = [];
    try {
      await reloader.ready;
      const getConfig = reloader.getCommittedRuntimeConfig;
      assert(getConfig);
      context.getCommittedRuntimeConfig = getConfig;
      context.getRuntimeConfig = getConfig;
      const dispatch = createDispatchTestHarness({
        buildRequestContext: () => context,
        getRequiredSharedGatewaySessionGeneration: generation.reader,
        extraHandlers: {
          wake: async (options) => {
            const captured = await captureGatewayOperatorRunAuthority({
              client: options.client,
              context,
              hasCurrentClientAuthority: options.hasCurrentClientAuthority,
            });
            assert(captured);
            captures.push(captured);
            guards.push(readGatewayRequestMutationAuthority(options));
            options.respond(true, { accepted: true });
          },
        },
      });
      const capture = async () => {
        await dispatch.dispatcher.dispatch(
          { type: "req", id: "scope-policy", method: "wake", params: {} },
          client,
        );
        expect(dispatch.send).toHaveBeenLastCalledWith(
          expect.objectContaining({ ok: true, payload: { accepted: true } }),
        );
        const original = captures.at(-1);
        assert(original);
        return original;
      };
      const original = await capture();
      delegated = await captureGatewayOperatorRunAuthority({
        client: { ...client, internal: { operatorRunAuthority: original.authority } },
        context,
      });
      assert(delegated);
      const prepareEffect = async (name: string, authority: typeof original.authority) => {
        const entered = createDeferred();
        const resume = createDeferred();
        releaseEffects.push(() => resume.resolve());
        const marker = path.join(effectDir, name);
        const command = [process.execPath, effectScript, marker]
          .map((arg) => JSON.stringify(arg))
          .join(" ");
        const outcome = withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:identity-scope-effect",
            operatorAuthority: authority,
          },
          async () => {
            const process = await runExecProcess({
              command,
              execCommand: command,
              workdir: effectDir,
              env: {},
              usePty: false,
              warnings: [],
              maxOutput: 1000,
              pendingMaxOutput: 1000,
              notifyOnExit: false,
              timeoutSec: null,
              scopeKey: effectDir,
              beforeSpawn: async () => {
                entered.resolve();
                await resume.promise;
                return undefined;
              },
            });
            processes.push(process);
            expect(process.pid).toBeGreaterThan(0);
            return await process.promise;
          },
        ).then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
        pendingEffects.push(outcome);
        // Only pause the existing asynchronous prelaunch hook. The exec runtime,
        // supervisor, native child launch, and filesystem effect remain real.
        await Promise.race([
          entered.promise,
          outcome.then(() => {
            throw new Error("exec settled before its prelaunch boundary");
          }),
        ]);
        await expect(fs.readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
        return { marker, outcome, release: () => resume.resolve() };
      };
      let revision = 0;
      const write = async (candidate: OpenClawConfig) => {
        const listener = fixture.ref.current;
        assert(listener);
        revision++;
        const application = publishConfigWrite(
          listener,
          createConfigWriteNotification(
            candidate,
            "scopes-" + revision,
            revision,
            "runtime-" + revision,
            "source-" + revision,
          ),
        );
        await tickUntilSettled(application);
        await expect(application).resolves.toBe("applied");
      };
      const allowedEffect = await prepareEffect("allowed.txt", original.authority);
      const unrelated = structuredClone(initialConfig);
      unrelated.gateway!.auth!.identityScopes!["other@example.test"] = ["operator.admin"];
      await write(unrelated);
      allowedEffect.release();
      await expect(allowedEffect.outcome).resolves.toMatchObject({
        value: { status: "completed", exitCode: 0 },
      });
      expect(await fs.readFile(allowedEffect.marker, "utf8")).toBe("accepted effect");
      expect(original.authority.signal?.aborted).toBe(false);
      expect(delegated.authority.signal?.aborted).toBe(false);
      expect(original.authority.assertCurrent).not.toThrow();
      for (const guard of guards) {
        expect(guard.family).toBe("worker");
        if (guard.family === "worker") {
          expect(guard.assertWorkerCurrent).not.toThrow();
        }
      }
      expect(close).not.toHaveBeenCalled();
      const reordered = structuredClone(unrelated);
      reordered.gateway!.auth!.identityScopes![identity] = [
        "operator.read",
        "operator.write",
        "operator.read",
      ];
      await write(reordered);
      expect(original.authority.assertCurrent).not.toThrow();
      await capture(); // The original connection must also admit subsequent requests.
      expect(captures).toHaveLength(2);
      const revokedEffect = await prepareEffect("revoked.txt", delegated.authority);
      const removed = structuredClone(reordered);
      delete removed.gateway!.auth!.identityScopes![identity];
      await write(removed);
      // Restore before consuming either continuation: a committed revocation is irreversible.
      await write(initialConfig);
      revokedEffect.release();
      const denied = await revokedEffect.outcome;
      expect(denied).toHaveProperty("error");
      if ("error" in denied) {
        expect(denied.error).toBeInstanceOf(Error);
        expect(String(denied.error)).toMatch(/authority is no longer active/);
      }
      await expect(fs.readFile(revokedEffect.marker)).rejects.toMatchObject({ code: "ENOENT" });
      expect(original.authority.signal?.aborted).toBe(true);
      expect(delegated.authority.signal?.aborted).toBe(true);
      expect(original.authority.assertCurrent).toThrow(/authority is no longer active/);
      expect(delegated.authority.assertCurrent).toThrow(/authority is no longer active/);
      expect(close).toHaveBeenCalledWith(4001, "gateway policy changed");
      expect(requestRecoveryRestart).not.toHaveBeenCalled();
    } finally {
      for (const release of releaseEffects) {
        release();
      }
      for (const process of processes) {
        if (!process.session.exited) {
          process.kill();
        }
      }
      await Promise.allSettled(pendingEffects);
      clearFinishedSessionsForScopes([effectDir]);
      await reloader.stop();
      delegated?.release();
      for (const captured of captures) {
        captured.release();
      }
    }
  });
});
