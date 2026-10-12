import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import type { Root } from "@openclaw/fs-safe/root";
import type { WatchOptions, WatchSubscription } from "@openclaw/fs-safe/watch";
import { describe, expect, it, vi } from "vitest";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import * as snapshots from "../infra/fs-observation-snapshot.js";
import type { GatewaySchedulerClock } from "../infra/gateway-scheduler.js";
import { createDeferredCore } from "../shared/deferred.js";
import { registerSkillsChangeListener } from "../skills/runtime/refresh.js";
import { createGatewaySchedulerClock } from "../test-utils/gateway-scheduler-clock.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const schedulerClock = vi.hoisted((): { clock?: GatewaySchedulerClock } => ({}));
type Observation = {
  authority: Root;
  options: WatchOptions;
  subscription: WatchSubscription;
};
const observations = vi.hoisted((): Observation[] => []);
const sampling: Promise<unknown>[] = [];

vi.mock("../infra/gateway-scheduler.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/gateway-scheduler.js")>();
  return {
    ...actual,
    GatewayScheduler: class extends actual.GatewayScheduler {
      constructor(options: ConstructorParameters<typeof actual.GatewayScheduler>[0] = {}) {
        super({ ...options, clock: schedulerClock.clock ?? options.clock });
      }
    },
  };
});
vi.mock("@openclaw/fs-safe/watch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/watch")>();
  return {
    ...actual,
    watch: (authority: Root, options: WatchOptions): WatchSubscription => {
      const subscription = actual.watch(authority, {
        ...options,
        mode: "poll",
        pollIntervalMs: 30_000,
      });
      observations.push({ authority, options, subscription });
      return subscription;
    },
  };
});

const execFileAsync = promisify(execFile);

function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
}

describe("Gateway agent skill refresh", () => {
  it(
    "refreshes canonical skills once per edit for managed worktrees and closes Gateway watchers",
    { timeout: 90_000 },
    (context) => {
      let state: OpenClawTestState | undefined;
      let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
      let gatewayStartup: ReturnType<typeof startGatewayWithClient> | undefined;
      let clientClose: Promise<void> | undefined;
      let gatewayClose: Promise<void> | undefined;
      let providerClose: Promise<void> | undefined;
      let providerListening = false;
      let unregisterLifecycle: (() => void) | undefined;
      const handlers = new Set<Promise<void>>();
      const handlerFailures: unknown[] = [];
      const requests: string[] = [];
      const providerServer = createServer((request, response) => {
        const handling = (async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          requests.push(Buffer.concat(chunks).toString("utf8"));
          const message = {
            type: "message",
            id: randomUUID(),
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "ok", annotations: [] }],
          };
          response.writeHead(200, { "content-type": "text/event-stream" });
          for (const event of [
            {
              type: "response.output_item.added",
              item: { ...message, status: "in_progress", content: [] },
            },
            { type: "response.output_item.done", item: message },
            {
              type: "response.completed",
              response: {
                status: "completed",
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ]) {
            response.write(`data: ${JSON.stringify(event)}\n\n`);
          }
          response.end("data: [DONE]\n\n");
        })().catch((error: unknown) => {
          handlerFailures.push(error);
          if (!response.destroyed) {
            response.writeHead(500).end(String(error));
          }
        });
        handlers.add(handling);
        void handling.then(
          () => handlers.delete(handling),
          (error: unknown) => {
            handlers.delete(handling);
            handlerFailures.push(error);
          },
        );
      });
      const closeClient = () =>
        (clientClose ??= gateway ? disconnectGatewayClient(gateway.client) : Promise.resolve());
      const closeGateway = () =>
        (gatewayClose ??= Promise.resolve().then(async () => {
          // A rejected acquisition may retain a server whose rollback did not finish.
          const started = gateway ?? (await gatewayStartup);
          await started?.server.close({ reason: "skill refresh test cleanup" });
        }));
      return runQaGatewayTestFixture(
        context,
        async ({ signal, verifyCleanup }) => {
          const time = createGatewaySchedulerClock(Date.now());
          schedulerClock.clock = time.clock;
          state = await createOpenClawTestState({
            label: "agent-skill-refresh",
            applyEnv: false,
            verifyCleanup,
            env: {
              OPENCLAW_GATEWAY_TOKEN: undefined,
              OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
              OPENCLAW_SKIP_CHANNELS: "1",
              OPENCLAW_SKIP_GMAIL_WATCHER: "1",
              OPENCLAW_SKIP_CRON: "1",
              OPENCLAW_SKIP_CANVAS_HOST: "1",
              OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
              OPENCLAW_SKIP_PROVIDERS: "1",
              OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            },
          });
          signal.throwIfAborted();
          const { workspaceDir: workspace, configPath } = state;
          const seedSkillFile = path.join(workspace, "skills", "seed-proof", "SKILL.md");
          const canonicalSkillFile = path.join(workspace, "skills", "canonical-proof", "SKILL.md");
          const bundledPluginsDir = state.path("empty-bundled-plugins");
          state.envVars.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;
          await Promise.all([
            fs.mkdir(path.dirname(seedSkillFile), { recursive: true }),
            fs.mkdir(bundledPluginsDir, { recursive: true }),
          ]);
          signal.throwIfAborted();
          await writeSkill(seedSkillFile, "seed-proof", "seed-skill-description");
          signal.throwIfAborted();
          await initializeGitWorkspace(workspace, signal);
          state.applyEnv();
          resetGatewayState();
          const readSnapshot = snapshots.readObservationSnapshot;
          vi.spyOn(snapshots, "readObservationSnapshot").mockImplementation((...args) => {
            const sample = readSnapshot(...args);
            sampling.push(sample);
            return sample;
          });
          const lifecycleEvents: string[] = [];
          const initialSkillsChange = createDeferredCore();
          unregisterLifecycle = registerSkillsChangeListener((event) => {
            lifecycleEvents.push(event.reason);
            initialSkillsChange.resolve();
          });
          await new Promise<void>((resolve, reject) => {
            providerServer.once("error", reject);
            providerServer.listen(0, "127.0.0.1", resolve);
          });
          providerListening = true;
          signal.throwIfAborted();
          const address = providerServer.address();
          if (!address || typeof address === "string") {
            throw new Error("mock provider did not bind");
          }
          const provider = buildMockOpenAiResponsesProvider(
            `http://127.0.0.1:${address.port}/v1`,
            "skill-refresh",
          );
          const token = `skill-refresh-${process.pid}`;
          const gatewayEvents: string[] = [];
          let skillsChanged = createDeferredCore();
          const cfg = {
            agents: {
              defaults: {
                workspace,
                skipBootstrap: true,
                model: { primary: provider.modelRef },
                models: {
                  [provider.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
                },
              },
            },
            gateway: { auth: { mode: "token", token } },
            models: { mode: "replace", providers: { [provider.providerId]: provider.config } },
            plugins: { slots: { memory: "none" } },
            tools: { profile: "coding" },
          } satisfies OpenClawConfig;
          gatewayStartup = startGatewayWithClient({
            cfg,
            configPath,
            token,
            scopes: ["operator.admin", "operator.read", "operator.write"],
            onEvent: (event) => {
              if (event.event) {
                gatewayEvents.push(event.event);
                if (event.event === "skills.changed") {
                  skillsChanged.resolve();
                }
              }
            },
          });
          gateway = await gatewayStartup;
          signal.throwIfAborted();

          const created = await gateway.client.request<{
            key: string;
            worktree: { path: string };
          }>(
            "sessions.create",
            {
              agentId: "main",
              worktree: true,
              worktreeBaseRef: "HEAD",
              label: "Skill refresh",
            },
            { signal },
          );
          signal.throwIfAborted();
          const sessionKey = created.key;
          const worktreeSeedSkillFile = path.join(
            created.worktree.path,
            "skills",
            "seed-proof",
            "SKILL.md",
          );
          await writeSkill(worktreeSeedSkillFile, "seed-proof", "worktree-only-description");
          await runAgentTurn(gateway.client, sessionKey, "first", signal);
          const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
          const first = loadSessionEntry({ agentId: "main", sessionKey, storePath });
          expect(first?.skillsSnapshot?.prompt).toContain("seed-skill-description");
          expect(first?.skillsSnapshot?.prompt).not.toContain("worktree-only-description");
          expect(requests.at(-1)).toContain("seed-skill-description");
          expect(requests.at(-1)).not.toContain("worktree-only-description");

          await racePromiseWithAbortSignal(initialSkillsChange.promise, signal);
          await settleSkillsWatchers(signal);
          await time.advanceBy(30_000);
          await racePromiseWithAbortSignal(skillsChanged.promise, signal);
          skillsChanged = createDeferredCore();
          const firstLifecycleCount = lifecycleEvents.length;
          const firstEventCount = countSkillsChanged(gatewayEvents);
          await editWatchedSkill(seedSkillFile, "seed-proof", "updated-seed-description", signal);
          expect(lifecycleEvents).toHaveLength(firstLifecycleCount + 1);
          await runAgentTurn(gateway.client, sessionKey, "second", signal);
          const second = loadSessionEntry({ agentId: "main", sessionKey, storePath });
          expect(second?.skillsSnapshot?.version).toBeGreaterThan(
            first?.skillsSnapshot?.version ?? 0,
          );
          expect(second?.skillsSnapshot?.prompt).toContain("updated-seed-description");
          expect(requests.at(-1)).toContain("updated-seed-description");
          await time.advanceBy(30_000);
          await racePromiseWithAbortSignal(skillsChanged.promise, signal);
          expect(countSkillsChanged(gatewayEvents)).toBe(firstEventCount + 1);

          await runAgentTurn(gateway.client, sessionKey, "third without edit", signal);
          const third = loadSessionEntry({ agentId: "main", sessionKey, storePath });
          expect(third?.skillsSnapshot?.version).toBe(second?.skillsSnapshot?.version);
          expect(lifecycleEvents).toHaveLength(firstLifecycleCount + 1);
          const repeatedTurnEventCount = lifecycleEvents.length;
          await editWatchedSkill(
            seedSkillFile,
            "seed-proof",
            "updated-seed-description-v2",
            signal,
          );
          expect(lifecycleEvents).toHaveLength(repeatedTurnEventCount + 1);
          await runAgentTurn(gateway.client, sessionKey, "fourth", signal);
          const fourth = loadSessionEntry({ agentId: "main", sessionKey, storePath });
          expect(fourth?.skillsSnapshot?.version).toBeGreaterThan(
            second?.skillsSnapshot?.version ?? 0,
          );
          expect(fourth?.skillsSnapshot?.prompt).toContain("updated-seed-description-v2");

          await fs.mkdir(path.dirname(canonicalSkillFile), { recursive: true });
          signal.throwIfAborted();
          const canonicalEventCount = lifecycleEvents.length;
          await editWatchedSkill(
            canonicalSkillFile,
            "canonical-proof",
            "canonical-root-description",
            signal,
          );
          expect(lifecycleEvents).toHaveLength(canonicalEventCount + 1);
          await runAgentTurn(gateway.client, sessionKey, "fifth", signal);
          const fifth = loadSessionEntry({ agentId: "main", sessionKey, storePath });
          expect(fifth?.skillsSnapshot?.version).toBeGreaterThan(
            fourth?.skillsSnapshot?.version ?? 0,
          );
          expect(fifth?.skillsSnapshot?.prompt).toContain("canonical-root-description");
          expect(requests.at(-1)).toContain("canonical-root-description");

          await closeClient();
          signal.throwIfAborted();
          const lifecycleCountBeforeClose = lifecycleEvents.length;
          const canonicalWatcher = observations.findLast(
            ({ authority, options, subscription }) =>
              subscription.health().state !== "closed" &&
              options.scopes.some(
                (scope) =>
                  path.resolve(authority.rootDir, scope.path) === path.join(workspace, "skills"),
              ),
          );
          expect(canonicalWatcher).toBeDefined();
          await closeGateway();
          signal.throwIfAborted();
          await writeSkill(canonicalSkillFile, "canonical-proof", "after-gateway-close");
          signal.throwIfAborted();
          expect(canonicalWatcher!.subscription.health().state).toBe("closed");
          expect(
            observations.every(({ subscription }) => subscription.health().state === "closed"),
          ).toBe(true);
          canonicalWatcher!.options.onInvalidate({
            reason: "event",
            changes: [
              {
                path: path.relative(canonicalWatcher!.authority.rootDir, canonicalSkillFile),
                type: "content",
              },
            ],
          });
          await settleSkillsWatchers(signal);
          await time.advanceBy(30_000);
          signal.throwIfAborted();
          expect(lifecycleEvents).toHaveLength(lifecycleCountBeforeClose);

          // Closing the Gateway first prevents a local watcher from reusing its subscription.
          const observationCountBeforeLocal = observations.length;
          const requestCountBeforeLocal = requests.length;
          const runtime = createRuntimeEnv();
          const { agentCliCommand } = await import("../commands/agent-via-gateway.js");
          await agentCliCommand(
            {
              local: true,
              agent: "main",
              sessionKey: "agent:main:local-skill-control",
              message: "local watcher control",
              json: true,
            },
            runtime,
          );
          signal.throwIfAborted();
          expect(runtime.error).not.toHaveBeenCalled();
          expect(vi.mocked(runtime.writeJson).mock.calls[0]?.[0]).toMatchObject({
            payloads: [{ text: "ok" }],
            meta: { aborted: false },
          });
          expect(requests).toHaveLength(requestCountBeforeLocal + 1);
          expect(requests.at(-1)).toContain("after-gateway-close");
          expect(observations).toHaveLength(observationCountBeforeLocal);
          expect(
            observations.every(({ subscription }) => subscription.health().state === "closed"),
          ).toBe(true);
          expect(lifecycleEvents).toHaveLength(lifecycleCountBeforeClose);
        },
        async () => {
          await runQaGatewayFixture(
            closeClient,
            closeGateway,
            () =>
              (providerClose ??= Promise.resolve().then(async () => {
                if (!providerListening) {
                  return;
                }
                const closed = new Promise<void>((resolve, reject) => {
                  providerServer.close((error) => (error ? reject(error) : resolve()));
                });
                providerServer.closeAllConnections();
                await runQaGatewayFixture(
                  () => closed,
                  async () => {
                    while (handlers.size > 0) {
                      await Promise.allSettled(handlers);
                    }
                    if (handlerFailures.length > 0) {
                      throw new AggregateError(
                        handlerFailures,
                        "Skill provider handler cleanup failed",
                      );
                    }
                  },
                );
              })),
            async () => {
              await runQaGatewayFixture(
                async () => unregisterLifecycle?.(),
                ...observations.map(
                  ({ subscription }) =>
                    () =>
                      subscription.close(),
                ),
                drainSkillsWatchSamples,
              );
            },
          );
          await state?.cleanup();
          observations.length = 0;
          sampling.length = 0;
          vi.restoreAllMocks();
          vi.useRealTimers();
          delete schedulerClock.clock;
          resetGatewayState();
        },
      );
    },
  );
});

async function runAgentTurn(
  client: Awaited<ReturnType<typeof startGatewayWithClient>>["client"],
  sessionKey: string,
  message: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const runId = randomUUID();
  const accepted = await client.request<{ runId?: string; status?: string }>(
    "agent",
    {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey: runId,
    },
    { signal },
  );
  signal.throwIfAborted();
  expect(accepted.status).toBe("accepted");
  const completed = await client.request<{ status?: string }>(
    "agent.wait",
    { runId: accepted.runId ?? runId, timeoutMs: 30_000 },
    { timeoutMs: 35_000, signal },
  );
  signal.throwIfAborted();
  expect(completed.status).toBe("ok");
}

function countSkillsChanged(events: readonly string[]): number {
  return events.filter((event) => event === "skills.changed").length;
}

// Guarded scans decide invalidation; discovery, broadcasts, snapshots, and provider requests stay real.
async function reconcileObservations(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await Promise.all(
    observations
      .filter(({ subscription }) => subscription.health().state !== "closed")
      .map(async ({ subscription }) => {
        await racePromiseWithAbortSignal(subscription.ready, signal);
        signal.throwIfAborted();
        await subscription.reconcile();
      }),
  );
  signal.throwIfAborted();
}

async function drainSkillsWatchSamples(): Promise<void> {
  const errors: unknown[] = [];
  while (sampling.length) {
    const results = await Promise.allSettled(sampling.splice(0));
    for (const result of results) {
      if (result.status === "rejected") {
        errors.push(result.reason);
      }
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Skills observation sampling failed");
  }
}

async function advanceSkillsWatchTimers(milliseconds: number, signal: AbortSignal): Promise<void> {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) {
    signal.throwIfAborted();
    await vi.advanceTimersByTimeAsync(Math.min(50, milliseconds - elapsed));
    await drainSkillsWatchSamples();
    signal.throwIfAborted();
  }
}

async function settleSkillsWatchers(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
    shouldClearNativeTimers: true,
  });
  try {
    await reconcileObservations(signal);
    await advanceSkillsWatchTimers(750, signal);
  } finally {
    vi.useRealTimers();
  }
}

async function editWatchedSkill(
  file: string,
  name: string,
  description: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const published = createDeferredCore();
  const unregister = registerSkillsChangeListener(() => published.resolve());
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
    shouldClearNativeTimers: true,
  });
  try {
    await writeSkill(file, name, description);
    await reconcileObservations(signal);
    await advanceSkillsWatchTimers(750, signal);
    await racePromiseWithAbortSignal(published.promise, signal);
    // Reconcile again after publication: unchanged bytes must not publish a second change.
    await reconcileObservations(signal);
    await advanceSkillsWatchTimers(750, signal);
  } finally {
    unregister();
    vi.useRealTimers();
  }
}

async function initializeGitWorkspace(workspace: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await execFileAsync("git", ["init", "-b", "main", workspace]);
  signal.throwIfAborted();
  await execFileAsync("git", ["-C", workspace, "config", "user.name", "OpenClaw Tests"]);
  signal.throwIfAborted();
  await execFileAsync("git", ["-C", workspace, "config", "user.email", "tests@openclaw.invalid"]);
  signal.throwIfAborted();
  await execFileAsync("git", ["-C", workspace, "add", "."]);
  signal.throwIfAborted();
  await execFileAsync("git", ["-C", workspace, "commit", "-m", "initial"]);
  signal.throwIfAborted();
}

async function writeSkill(file: string, name: string, description: string): Promise<void> {
  await fs.writeFile(
    file,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}
