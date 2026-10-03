import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type * as QaLabApi from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import type { CronJob } from "../../../../src/cron/types.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { loadBundledPluginFacade } from "../../../../src/test-utils/bundled-plugin-public-surface.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../helpers/openclaw-test-instance.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const BASELINE_SHA = "b1c09f1088e0fba7b91c661d3b20b945c96ab141";
const EVERY_MS = 60_000;
const PHASE_TIMEOUT_MS = 240_000;
const CONVERSATION = "qa-heartbeat-migration";

type LegacyMonitorJob = Omit<CronJob, "payload"> & { payload: { kind: string } };

type RunRecord = { status?: string; runAtMs?: number; deliveryStatus?: string; ts?: number };

async function callGateway<T>(
  instance: OpenClawTestInstance,
  method: string,
  params = {},
): Promise<T> {
  const result = await instance.cli(
    [
      "gateway",
      "call",
      method,
      "--params",
      JSON.stringify(params),
      "--json",
      "--url",
      instance.url,
      "--token",
      instance.gatewayToken,
      "--timeout",
      "30000",
    ],
    { timeoutMs: 60_000 },
  );
  assert.equal(result.code, 0, `${method} failed: ${result.stderr}`);
  return JSON.parse(result.stdout) as T;
}

async function waitForEvidence<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await sleep(500);
  }
  throw new Error(`Timed out awaiting ${label}`);
}

export async function runHeartbeatAutomationMigrationLive(options: {
  repoRoot: string;
  outputDir: string;
  baselineRoot: string;
}) {
  const actualBaseline = execFileSync("git", ["-C", options.baselineRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  assert.equal(
    actualBaseline,
    BASELINE_SHA,
    "The baseline checkout must match the reviewed pre-refactor source",
  );
  const api = await loadBundledPluginFacade<typeof QaLabApi>({
    pluginId: "qa-lab",
    artifactBasename: "api.ts",
  });
  const busState = api.createQaBusState();
  const instances: OpenClawTestInstance[] = [];
  const startedAt = Date.now();
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.outputDir,
    logFileName: "heartbeat-automation-migration.log",
    primaryModel: "live model",
    providerMode: "live-frontier",
    repoRoot: options.repoRoot,
    target: {
      id: "heartbeat-automation-migration-live",
      title: "Heartbeat upgrade through Doctor and ordinary automation",
      sourcePath: "test/e2e/qa-lab/runtime/heartbeat-automation-migration-live.ts",
      docsRefs: ["docs/gateway/heartbeat.md"],
      codeRefs: [
        "src/commands/doctor-heartbeat-cadence-migration.ts",
        "src/cron/service/timer-scheduler.ts",
      ],
    },
  });
  await fs.mkdir(options.outputDir, { recursive: true });
  const bus = await api.startQaBusServer({ state: busState });
  const proof: Record<string, unknown> = {
    baselineSha: actualBaseline,
    naturalScheduling: true,
    model: "live model",
  };
  let modelIdentifiers: string[] = [];
  const publicEvidence = (text: string) => {
    let redacted = text;
    for (const identifier of modelIdentifiers) {
      redacted = redacted.replaceAll(identifier, "[live model]");
    }
    return redacted;
  };
  let evidence: Awaited<ReturnType<typeof writer.write>>;
  let cleanupFailure: AggregateError | undefined;
  try {
    const fixtureEnv = {
      OPENCLAW_BUILD_PRIVATE_QA: "1",
      OPENCLAW_ENABLE_PRIVATE_QA_CLI: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_SKIP_CRON: undefined,
      OPENCLAW_SKIP_CHANNELS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_AGENT_RUNTIME: "openclaw",
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_STATE_DIR: undefined,
    };
    const baseline = await createOpenClawTestInstance({
      name: "heartbeat-before-migration",
      cwd: options.baselineRoot,
      env: fixtureEnv,
      startTimeoutMs: PHASE_TIMEOUT_MS,
    });
    instances.push(baseline);
    const configured = api.buildQaGatewayConfig({
      bind: "loopback",
      gatewayPort: baseline.port,
      gatewayToken: baseline.gatewayToken,
      workspaceDir: baseline.state.workspaceDir,
      providerMode: "live-frontier",
      transportPluginIds: ["qa-channel"],
      transportConfig: {
        channels: {
          "qa-channel": { baseUrl: bus.baseUrl, allowFrom: ["*"], botUserId: "openclaw" },
        },
      },
    });
    modelIdentifiers = [
      ...new Set(
        Object.keys(configured.agents?.defaults?.models ?? {}).flatMap((reference) => [
          reference,
          reference.slice(reference.indexOf("/") + 1),
        ]),
      ),
    ]
      .filter(Boolean)
      .toSorted((left, right) => right.length - left.length);
    const heartbeat = {
      every: `${EVERY_MS}ms`,
      isolatedSession: true,
      activeHours: { start: "00:00", end: "24:00", timezone: "UTC" },
      target: "qa-channel",
      to: `dm:${CONVERSATION}`,
      directPolicy: "allow",
      prompt:
        "Read this automation's scratch checklist and report its exact QA-MIGRATION marker. If heartbeat_respond is available, finish with outcome done, notify true, and the marker as both summary and notificationText. Otherwise finish with the marker as your only reply. Do not call message or change any state.",
    };
    const legacyConfig = {
      ...configured,
      meta: { lastTouchedVersion: "2026.7.1" },
      agents: { ...configured.agents, defaults: { ...configured.agents?.defaults, heartbeat } },
    };
    await baseline.state.writeConfig(legacyConfig);
    await fs.mkdir(baseline.state.workspaceDir, { recursive: true });
    await fs.writeFile(
      path.join(baseline.state.workspaceDir, "AGENTS.md"),
      "This workspace contains synthetic QA data. Follow the automation scratch instructions exactly.\n",
    );
    const prepare = await baseline.cli(["doctor", "--fix", "--non-interactive"], {
      timeoutMs: PHASE_TIMEOUT_MS,
    });
    assert.equal(prepare.code, 0, `Baseline Doctor failed: ${prepare.stderr}`);
    await baseline.startGateway();
    const oldJob = await waitForEvidence(async () => {
      const inventory = await callGateway<{ jobs: LegacyMonitorJob[] }>(baseline, "cron.list", {
        includeDisabled: true,
      });
      return inventory.jobs.find((job) => job.agentId === "qa" && job.payload.kind === "heartbeat");
    }, "baseline heartbeat monitor startup");
    assert.ok(oldJob?.id, "Baseline must have its config-owned heartbeat monitor");
    const beforeMarker = `QA-MIGRATION-BEFORE-${randomUUID()}`;
    const beforeStartedAt = Date.now();
    await callGateway(baseline, "cron.scratch.set", {
      id: oldJob.id,
      content: `Report exactly ${beforeMarker}.`,
    });
    await busState.waitFor({
      kind: "message-text",
      direction: "outbound",
      textIncludes: beforeMarker,
      timeoutMs: PHASE_TIMEOUT_MS,
    });
    const beforeRun = await waitForEvidence(async () => {
      const runs = await callGateway<{ entries: RunRecord[] }>(baseline, "cron.runs", {
        id: oldJob.id,
        limit: 20,
      });
      return runs.entries.find(
        (entry) =>
          entry.status === "ok" &&
          (entry.ts ?? 0) >= beforeStartedAt &&
          Number.isFinite(entry.runAtMs),
      );
    }, "baseline natural occurrence settlement");
    assert.ok(beforeRun, "Baseline natural occurrence must settle in canonical run history");
    await baseline.stopGateway();
    proof.before = { jobId: oldJob.id, marker: beforeMarker, run: beforeRun };

    // Capture the stopped baseline before constructing another fixture. This flow
    // proves in-place migration; backup and rollback have their own update proof.
    const priorConfigBytes = await fs.readFile(baseline.configPath, "utf8");
    const priorConfig = JSON.parse(priorConfigBytes) as OpenClawConfig;
    const candidate = await createOpenClawTestInstance({
      name: "heartbeat-after-migration",
      cwd: options.repoRoot,
      env: fixtureEnv,
      startTimeoutMs: PHASE_TIMEOUT_MS,
    });
    instances.push(candidate);
    assert.notEqual(candidate.stateDir, baseline.stateDir);
    assert.notEqual(candidate.configPath, baseline.configPath);
    assert.equal(await fs.readFile(baseline.configPath, "utf8"), priorConfigBytes);
    // The helper exposes the exact environment shared by its CLI and Gateway
    // children. Bind it only after construction has finished writing its own config.
    candidate.env.OPENCLAW_STATE_DIR = baseline.stateDir;
    candidate.env.OPENCLAW_CONFIG_PATH = baseline.configPath;
    await baseline.state.writeConfig({
      ...priorConfig,
      gateway: {
        ...priorConfig.gateway,
        port: candidate.port,
        auth: { mode: "token", token: candidate.gatewayToken },
      },
    });
    const migrated = await candidate.cli(["doctor", "--fix", "--non-interactive"], {
      timeoutMs: PHASE_TIMEOUT_MS,
    });
    assert.equal(migrated.code, 0, `Candidate Doctor failed: ${migrated.stderr}`);
    const candidateConfig = JSON.parse(
      await fs.readFile(baseline.configPath, "utf8"),
    ) as OpenClawConfig;
    assert.equal(
      candidateConfig.agents?.defaults?.heartbeat,
      undefined,
      "Doctor must remove the legacy runtime configuration",
    );
    await candidate.startGateway();
    const inventory = await callGateway<{ jobs: CronJob[] }>(candidate, "cron.list", {
      includeDisabled: true,
    });
    const job = inventory.jobs.find((row) => row.id === oldJob.id);
    assert.ok(job, "Migration must preserve the existing monitor identity");
    assert.equal(job.payload.kind, "agentTurn");
    assert.deepEqual(job.activeHours, heartbeat.activeHours);
    assert.equal(job.schedule.kind === "every" && job.schedule.everyMs, EVERY_MS);
    assert.equal(job.delivery?.channel, "qa-channel");
    assert.equal(job.delivery?.to, `dm:${CONVERSATION}`);
    const afterMarker = `QA-MIGRATION-AFTER-${randomUUID()}`;
    const afterStartedAt = Date.now();
    await callGateway(candidate, "cron.scratch.set", {
      id: job.id,
      content: `Report exactly ${afterMarker}.`,
    });
    await busState.waitFor({
      kind: "message-text",
      direction: "outbound",
      textIncludes: afterMarker,
      timeoutMs: PHASE_TIMEOUT_MS,
    });
    const afterRun = await waitForEvidence(async () => {
      const runs = await callGateway<{ entries: RunRecord[] }>(candidate, "cron.runs", {
        id: job.id,
        limit: 20,
      });
      return runs.entries.find(
        (entry) =>
          entry.status === "ok" &&
          (entry.ts ?? 0) >= afterStartedAt &&
          Number.isFinite(entry.runAtMs),
      );
    }, "candidate natural occurrence settlement");
    assert.ok(afterRun, "Migrated natural occurrence must settle in canonical run history");
    assert.equal(afterRun.deliveryStatus, "delivered");
    await candidate.stopGateway();
    const messages = busState
      .getSnapshot()
      .messages.filter(
        (message) =>
          message.direction === "outbound" &&
          [beforeMarker, afterMarker].some((marker) => message.text.includes(marker)),
      );
    for (const marker of [beforeMarker, afterMarker]) {
      const matching = messages.filter((message) => message.text.includes(marker));
      assert.equal(matching.length, 1, `Expected exactly one delivered ${marker}`);
      const [delivered] = matching;
      assert.ok(delivered, `Expected the delivered ${marker}`);
      assert.deepEqual(
        { kind: delivered.conversation.kind, id: delivered.conversation.id },
        { kind: "direct", id: CONVERSATION },
      );
    }
    proof.after = {
      jobId: job.id,
      marker: afterMarker,
      run: afterRun,
      schedule: job.schedule,
      delivery: job.delivery,
    };
    proof.deliveryCount = messages.length;
    const summaryPath = path.join(options.outputDir, "heartbeat-automation-migration-summary.json");
    await fs.mkdir(options.outputDir, { recursive: true });
    await fs.writeFile(summaryPath, `${JSON.stringify(proof, null, 2)}\n`);
    evidence = await writer.write({
      status: "pass",
      durationMs: Date.now() - startedAt,
      details:
        "Baseline heartbeat and Doctor-migrated ordinary automation both fired naturally and delivered once.",
      artifacts: [{ kind: "summary", filePath: summaryPath }],
    });
  } catch (error) {
    for (const instance of instances) {
      writer.appendLog(publicEvidence(`${instance.name}:\n${instance.logs()}\n`));
    }
    evidence = await writer.write({
      status: "fail",
      durationMs: Date.now() - startedAt,
      details: publicEvidence(formatErrorMessage(error)),
    });
  } finally {
    const cleanupErrors: unknown[] = [];
    for (const instance of instances.toReversed()) {
      try {
        await instance.cleanup();
      } catch (error) {
        cleanupErrors.push(error);
        // The candidate borrows the baseline's physical state. A failed child
        // cleanup must retain that earlier fixture until its owner is settled.
        break;
      }
    }
    try {
      await bus.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      cleanupFailure = new AggregateError(cleanupErrors, "Migration proof cleanup failed");
      writer.appendLog(publicEvidence(formatErrorMessage(cleanupFailure)));
    }
  }
  if (cleanupFailure) {
    throw cleanupFailure;
  }
  return evidence;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const baselineArg = process.argv.indexOf("--baseline-root");
  const baselineRoot = baselineArg >= 0 ? process.argv[baselineArg + 1] : undefined;
  assert.ok(baselineRoot, "Pass --baseline-root <path> for the pinned baseline checkout");
  const outputArg = process.argv.indexOf("--output-dir");
  const outputDir =
    outputArg >= 0
      ? process.argv[outputArg + 1]
      : ".artifacts/qa-e2e/heartbeat-automation-migration-live";
  assert.ok(outputDir);
  const evidence = await runHeartbeatAutomationMigrationLive({
    repoRoot: process.cwd(),
    outputDir: path.resolve(outputDir),
    baselineRoot: path.resolve(baselineRoot),
  });
  process.exitCode = evidence.entries[0]?.result.status === "pass" ? 0 : 1;
}
