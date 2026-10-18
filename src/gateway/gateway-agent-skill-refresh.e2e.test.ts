import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../test/helpers/qa-gateway-test-lifetime.js";
import "../commands/agent.js";
import { agentCliCommand } from "../commands/agent-via-gateway.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { resetConfigOverrides } from "../config/runtime-overrides.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { getTrackedWorkerPoolSnapshot } from "../infra/worker-cpu.js";
import {
  closeSkillsWatchers,
  refreshSkillsDiscovery,
  registerSkillsChangeListener,
} from "../skills/runtime/refresh.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { createTrackedProvider } from "./test-helpers.tracked-provider.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";
// Keep cold subject imports outside the skill-refresh behavior's timeout.
import "./server-start.js";

const execFileAsync = promisify(execFile);

function resetGatewayState(): void {
  resetConfigOverrides();
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest({ preserveListeners: true });
}

it(
  "refreshes canonical skills explicitly for managed worktrees and closes its discovery worker",
  { timeout: 90_000 },
  (context) => {
    let state: OpenClawTestState | undefined;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let gatewayStartup: ReturnType<typeof startGatewayWithClient> | undefined;
    let clientClose: Promise<void> | undefined;
    let gatewayClose: Promise<void> | undefined;
    let unregisterLifecycle: (() => void) | undefined;
    const requests: string[] = [];
    const providerServer = createTrackedProvider((raw, response) => {
      requests.push(raw);
      writeOpenAiResponsesText(response, {
        text: "ok",
        messageId: randomUUID(),
        responseId: randomUUID(),
      });
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
        const lifecycleEvents: string[] = [];
        unregisterLifecycle = registerSkillsChangeListener((event) => {
          lifecycleEvents.push(event.reason);
        });
        const provider = buildMockOpenAiResponsesProvider(
          await providerServer.listen(),
          "skill-refresh",
        );
        signal.throwIfAborted();
        const token = `skill-refresh-${process.pid}`;
        const gatewayEvents: string[] = [];
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
          skills: { load: { watch: false } },
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
            }
          },
        });
        gateway = await gatewayStartup;
        signal.throwIfAborted();

        const created = await gateway.client.request<{ key: string; worktree: { path: string } }>(
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
        const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
        const activeClient = gateway.client;
        const turn = async (message: string) => {
          signal.throwIfAborted();
          const runId = randomUUID();
          const accepted = await activeClient.request<{ runId?: string; status?: string }>(
            "agent",
            { sessionKey, message, deliver: false, idempotencyKey: runId },
            { signal },
          );
          signal.throwIfAborted();
          expect(accepted.status).toBe("accepted");
          const completed = await activeClient.request<{ status?: string }>(
            "agent.wait",
            { runId: accepted.runId ?? runId, timeoutMs: 30_000 },
            { timeoutMs: 35_000, signal },
          );
          signal.throwIfAborted();
          expect(completed.status).toBe("ok");
          return loadSessionEntry({ agentId: "main", sessionKey, storePath })?.skillsSnapshot;
        };
        const refreshTurn = async (
          file: string,
          description: string,
          message: string,
          version = 0,
        ) => {
          const lifecycleCount = lifecycleEvents.length;
          signal.throwIfAborted();
          await writeSkill(file, path.basename(path.dirname(file)), description);
          await refreshSkillsDiscovery({ workspaceDir: workspace });
          signal.throwIfAborted();
          expect(lifecycleEvents.length).toBeGreaterThan(lifecycleCount);
          const current = await turn(message);
          expect(current?.version).toBeGreaterThan(version);
          expect(current?.prompt).toContain(description);
          return current;
        };
        const first = await turn("first");
        for (const prompt of [first?.prompt, requests.at(-1)]) {
          expect(prompt).toContain("seed-skill-description");
          expect(prompt).not.toContain("worktree-only-description");
        }
        expect(discoveryWorkers()).toEqual([expect.objectContaining({ workerCount: 1 })]);
        const firstEventCount = countSkillsChanged(gatewayEvents);
        const second = await refreshTurn(
          seedSkillFile,
          "updated-seed-description",
          "second",
          first?.version,
        );
        expect(requests.at(-1)).toContain("updated-seed-description");
        expect(countSkillsChanged(gatewayEvents)).toBeGreaterThan(firstEventCount);
        const secondLifecycleCount = lifecycleEvents.length;
        const secondEventCount = countSkillsChanged(gatewayEvents);

        const third = await turn("third without edit");
        expect(third?.version).toBe(second?.version);
        expect(lifecycleEvents).toHaveLength(secondLifecycleCount);
        expect(countSkillsChanged(gatewayEvents)).toBe(secondEventCount);
        const fourth = await refreshTurn(
          seedSkillFile,
          "updated-seed-description-v2",
          "fourth",
          second?.version,
        );

        await fs.mkdir(path.dirname(canonicalSkillFile), { recursive: true });
        signal.throwIfAborted();
        await refreshTurn(
          canonicalSkillFile,
          "canonical-root-description",
          "fifth",
          fourth?.version,
        );
        expect(requests.at(-1)).toContain("canonical-root-description");

        await closeClient();
        signal.throwIfAborted();
        const lifecycleCountBeforeClose = lifecycleEvents.length;
        await closeGateway();
        signal.throwIfAborted();
        expect(discoveryWorkers()).toEqual([]);
        await writeSkill(canonicalSkillFile, "canonical-proof", "after-gateway-close");
        signal.throwIfAborted();
        expect(lifecycleEvents).toHaveLength(lifecycleCountBeforeClose);

        const requestCountBeforeLocal = requests.length;
        const runtime = createRuntimeEnv();
        await agentCliCommand(
          {
            local: true,
            agent: "main",
            sessionKey: "agent:main:local-skill-control",
            message: "local discovery control",
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
        expect(lifecycleEvents).toHaveLength(lifecycleCountBeforeClose);
      },
      async () => {
        await runQaGatewayFixture(
          closeClient,
          closeGateway,
          () => providerServer.close(),
          async () => {
            await runQaGatewayFixture(
              async () => unregisterLifecycle?.(),
              () => closeSkillsWatchers(true),
            );
          },
        );
        await state?.cleanup();
        vi.restoreAllMocks();
        resetGatewayState();
      },
    );
  },
);

function countSkillsChanged(events: readonly string[]): number {
  return events.filter((event) => event === "skills.changed").length;
}

function discoveryWorkers() {
  return getTrackedWorkerPoolSnapshot().workerPools.filter(
    (pool) => pool.script === "discovery.worker.js",
  );
}

async function initializeGitWorkspace(workspace: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  for (const args of [
    ["init", "-b", "main", workspace],
    ["-C", workspace, "config", "user.name", "OpenClaw Tests"],
    ["-C", workspace, "config", "user.email", "tests@openclaw.invalid"],
    ["-C", workspace, "add", "."],
    ["-C", workspace, "commit", "-m", "initial"],
  ]) {
    await execFileAsync("git", args);
    signal.throwIfAborted();
  }
}

async function writeSkill(file: string, name: string, description: string): Promise<void> {
  await fs.writeFile(
    file,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}
