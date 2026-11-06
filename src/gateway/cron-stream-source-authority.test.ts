import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { toPublicCronJob } from "../cron/public-job.js";
import { CronService } from "../cron/service.js";
import { resolveCronOperatorExecutionRevision } from "../cron/service/jobs-tool-policy.js";
import { applyJobPatch } from "../cron/service/jobs.js";
import { loadCronStore } from "../cron/store.js";
import type { CronStoredJob } from "../cron/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { ensureCanonicalGatewayOwnerProfile } from "../state/user-profile-writes.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createCronStreamWatcherFixture, job } from "./cron-stream-watchers.test-helpers.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";
import type { OperatorRunRecoverySnapshot } from "./operator-run-recovery-source.codec.js";
import { recoveryFixture } from "./operator-run-recovery.test-support.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  SharedGatewaySessionGenerationState,
  enforceSharedGatewaySessionGenerationForConfigWrite,
} from "./server-shared-auth-generation.js";

const principal = (peer: string): OpenClawIdTunnelPrincipal => ({
  kind: "owner",
  peerKey: `iroh:${peer.repeat(32)}`,
  authority: { clawId: "stream-claw", rootPub: "stream-root", listedSeq: 1 },
});
const source = (snapshot: OperatorRunRecoverySnapshot) => ({
  version: 1 as const,
  kind: "gateway" as const,
  agentId: "main",
  sourceRunId: "source-turn",
  snapshot,
});

/** Real durable cron owner; only OS process execution is replaced by the watcher fixture. */
function createCron(storePath: string) {
  return new CronService({
    storePath,
    scheduler: createTestGatewayScheduler(),
    cronEnabled: true,
    defaultAgentId: "main",
    cronConfig: { triggers: { enabled: true } },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    enqueueSystemEvent: () => {},
    runIsolatedAgentJob: async () => ({ status: "ok" }),
  });
}

it("keeps process A through payload B edits and durable recovery, then accepts explicit ordinary reauthorization", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const profile = await ensureCanonicalGatewayOwnerProfile("Synthetic owner");
    const a = principal("da"),
      b = principal("db");
    const peers = new Map([
      [a.peerKey, a],
      [b.peerKey, b],
    ]);
    setOpenClawIdTunnelPrincipalLookup((peer) => peers.get(peer));
    const context = createContext();
    const first = await recoveryFixture(stateDir, profile.id, { context, openclawIdPrincipal: a });
    const second = await recoveryFixture(stateDir, profile.id, { context, openclawIdPrincipal: b });
    const sharedOwner = new SharedGatewaySessionGenerationState({
      current: "stream-generation-a",
      required: null,
    });
    context.sharedGatewaySessionGenerationState = sharedOwner;
    const ordinary = await recoveryFixture(stateDir, profile.id, {
      context,
      config: { gateway: { auth: { mode: "token", token: "stream-token-a" } } },
      sharedGeneration: "stream-generation-a",
    });
    const storePath = path.join(stateDir, "cron", "jobs.json");
    const cron = createCron(storePath);
    const recovered = createCron(storePath);
    context.cron = cron;
    context.resolveGatewayContext = () => context;
    const createWatchers = () =>
      createCronStreamWatcherFixture({ resolveGatewayContext: () => context });
    const live = createWatchers(),
      restarted = createWatchers(),
      refused = createWatchers(),
      reauthorized = createWatchers();
    const execCheck = vi.fn();
    const execPolicy = { kind: "resolved" as const, assertCurrent: execCheck };
    try {
      const created = await cron.add(job(), {
        operatorSource: source(first.snapshot),
        streamOperatorSource: first.snapshot,
        execPolicy,
      });
      await live.watchers.start(created);
      expect(live.fake.spawn).toHaveBeenCalledOnce();
      const payload = { kind: "agentTurn" as const, message: "new payload from B" };
      const proposed = structuredClone(created);
      applyJobPatch(proposed, { payload });
      const revision = resolveCronOperatorExecutionRevision(proposed);
      execCheck.mockClear();
      const edited = await cron.update(
        created.id,
        { payload },
        {
          operatorSource: source(second.snapshot),
          operatorSourceExecutionRevision: revision,
          // Even a supplied private snapshot cannot replace the process outside an exec edge.
          streamOperatorSource: second.snapshot,
        },
      );
      expect(execCheck).not.toHaveBeenCalled();
      expect(edited.streamOperatorSource).toEqual(first.snapshot);
      expect(edited.operatorSource?.source.snapshot).toEqual(second.snapshot);
      expect(edited.state.streamSourceIdentity).toBe(created.state.streamSourceIdentity);
      expect(
        resolveCronOperatorExecutionRevision({ ...edited, streamOperatorSource: second.snapshot }),
      ).toBe(revision);
      expect(toPublicCronJob(edited)).not.toHaveProperty("streamOperatorSource");
      await live.watchers.start(edited);
      expect(live.fake.spawn).toHaveBeenCalledOnce();
      await live.watchers.stopAll("shutdown");
      cron.stop();

      const stored = expectDefined(
        (await loadCronStore(storePath)).jobs[0],
        "persisted native stream",
      );
      expect(stored.streamOperatorSource).toEqual(first.snapshot);
      expect(stored.operatorSource?.source.snapshot).toEqual(second.snapshot);
      context.cron = recovered;
      await recovered.readJob(stored.id);
      await restarted.watchers.start(stored);
      expect(restarted.fake.spawn).toHaveBeenCalledOnce();
      peers.delete(a.peerKey);
      setOpenClawIdTunnelPrincipalLookup((peer) => peers.get(peer));
      expect(restarted.fake.runs[0]?.cancel).toHaveBeenCalled();
      await restarted.watchers.stopAll("shutdown");
      await refused.watchers.start(stored);
      await refused.watchers.stopAll("shutdown");
      expect(refused.fake.spawn).not.toHaveBeenCalled();

      // A current ordinary Gateway owner may replace the original OCID grant at enable.
      const enabled = await recovered.update(
        stored.id,
        { enabled: true },
        {
          operatorSource: source(ordinary.snapshot),
          operatorSourceExecutionRevision: revision,
          streamOperatorSource: ordinary.snapshot,
          execPolicy,
        },
      );
      expect(execCheck).toHaveBeenCalled();
      expect(enabled.state.streamSourceIdentity).not.toBe(stored.state.streamSourceIdentity);
      expect(enabled.schedule).toEqual(stored.schedule);
      await reauthorized.watchers.start(enabled);
      expect(reauthorized.fake.spawn).toHaveBeenCalledOnce();
      const nextConfig = { gateway: { auth: { mode: "token" as const, token: "stream-token-b" } } };
      ordinary.setConfig(nextConfig);
      enforceSharedGatewaySessionGenerationForConfigWrite({
        state: sharedOwner,
        nextConfig,
        resolveRuntimeSnapshotGeneration: () => "stream-generation-b",
        clients: [],
      });
      publishOperatorRoleConfigChange(context);
      expect(reauthorized.fake.runs[0]?.cancel).toHaveBeenCalled();
    } finally {
      for (const fixture of [live, restarted, refused, reauthorized]) {
        await fixture.watchers.stopAll("shutdown");
      }
      cron.stop();
      recovered.stop();
      setOpenClawIdTunnelPrincipalLookup(undefined);
    }
  });
});

it("cancels an unchanged OCID native process when its original app grant is revoked", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const original = { pluginId: "stream-access", grantId: "original-stream-grant" };
    const controller = new AbortController();
    const grant = {
      grantId: original.grantId,
      signal: controller.signal,
      assertCurrent: () => controller.signal.throwIfAborted(),
    };
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(createPluginRecord({ id: original.pluginId }));
    const resume = vi.fn(() => grant);
    registry.gatewayAccessPolicies.push({
      pluginId: original.pluginId,
      source: "fixture",
      policy: { authorize: () => grant, resume },
    });
    const previous = captureActivePluginRegistrySnapshot();
    stageActivePluginRegistry(registry, null, "default");
    const peer = principal("dc");
    setOpenClawIdTunnelPrincipalLookup(() => peer);
    const context = createContext();
    const cron = createCron(path.join(stateDir, "cron", "jobs.json"));
    context.cron = cron;
    context.resolveGatewayContext = () => context;
    const fixture = createCronStreamWatcherFixture({ resolveGatewayContext: () => context });
    try {
      const profile = await ensureCanonicalGatewayOwnerProfile("Synthetic owner");
      const captured = await recoveryFixture(stateDir, profile.id, {
        context,
        openclawIdPrincipal: peer,
        gatewayAccessGrant: original,
      });
      const created: CronStoredJob = await cron.add(job(), {
        operatorSource: source(captured.snapshot),
        streamOperatorSource: captured.snapshot,
      });
      await fixture.watchers.start(created);
      expect(fixture.fake.spawn).toHaveBeenCalledOnce();
      expect(resume).toHaveBeenCalledWith(expect.objectContaining({ grantId: original.grantId }));
      controller.abort(new Error("Original stream grant revoked"));
      expect(fixture.fake.runs[0]?.cancel).toHaveBeenCalled();
      await fixture.watchers.stopAll("shutdown");
      expect(fixture.watchers.inspect(created.id)).toMatchObject({
        state: "stopped",
        processAlive: false,
      });
    } finally {
      await fixture.watchers.stopAll("shutdown");
      cron.stop();
      setOpenClawIdTunnelPrincipalLookup(undefined);
      restoreActivePluginRegistrySnapshot(previous);
    }
  });
});
