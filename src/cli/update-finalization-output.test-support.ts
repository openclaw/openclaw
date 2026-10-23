// Keep CLI/output/lifecycle owners real; filesystem, plugins, and Doctor are synthetic.
import fs from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { SQLITE_READONLY_CHILD_ARG } from "../infra/runtime-process-entrypoints.js";
import { finalizationFixtureClockUrl as fixtureClockUrl } from "./update-finalization-clock.test-support.js";

await import(fixtureClockUrl);
const require = createRequire(import.meta.url);
const root = process.env.HOME!;
await fs.writeFile(
  path.join(root, "package.json"),
  JSON.stringify({ name: "openclaw", version: "2026.9.4" }),
);
const [runtimeProcessEntrypointsJson, scenario, ...args] = process.argv.slice(2);
const borrowed = scenario?.startsWith("borrowed-");
const repairDeadline = scenario?.startsWith("repair-deadline");
const blockedChildSource = `
const fs = require('node:fs');
process.title = 'node fixture-private-argument';
fs.writeFileSync(${JSON.stringify(path.join(root, "blocked-child.pid"))}, String(process.pid));
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
`;
if (scenario === "completion-hang") {
  await fs.writeFile(
    path.join(root, "openclaw.mjs"),
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(path.join(root, "completion.pid"))}, String(process.pid));
process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 10_000);`,
  );
}
if (scenario === "human-recovery-plugin-error") {
  Object.defineProperty(process.stdin, "isTTY", { value: true });
  Object.defineProperty(process.stdout, "isTTY", { value: true });
}
const sourceUrl = (relative: string) =>
  new URL(
    import.meta.url.endsWith(".js") ? relative.replace(/\.ts$/u, ".js") : relative,
    import.meta.url,
  ).href;
const doctorDeadline = scenario === "doctor-hang" || scenario === "doctor-progress";
// Keep native/HTTP observations and their full budgets; only recovery polling advances time.
const recoveryClockUrl = `data:text/javascript,${encodeURIComponent(`
export * from ${JSON.stringify(sourceUrl("../utils.ts"))};
const realMonotonicNow = performance.now.bind(performance);
const realWallNow = Date.now;
export let elapsed = 0;
Object.defineProperty(performance, 'now', { value: () => realMonotonicNow() + elapsed });
Date.now = () => realWallNow() + Math.floor(elapsed);
export async function sleep(ms, signal) {
  signal?.throwIfAborted();
  if (elapsed === 0) process.stderr.write('Fixture advanced recovery clock.\\n');
  elapsed += ms;
  await new Promise(resolve => setImmediate(resolve));
  signal?.throwIfAborted();
}
`)}`;
// Exhaust the recovery budget in its first interval, so real reads cannot race
// a nearly spent fake deadline. HTTP probe sleeps must keep their own increments.
const recoveryIntervalClockUrl = `data:text/javascript,${encodeURIComponent(`
import { sleep as advance } from ${JSON.stringify(recoveryClockUrl)};
export const sleep = (ms, signal) => advance(ms + 3_600_000, signal);
`)}`;
const recoveryClockUrls = new Map([
  [sourceUrl("./daemon-cli/restart-health.ts"), recoveryIntervalClockUrl],
  [sourceUrl("./daemon-cli/restart-health-probe.ts"), recoveryClockUrl],
]);
const doctorSource = `
export async function doctorCommand() {
  if (process.argv.includes('--lint')) {
    console.log(JSON.stringify({ ok: true, checksRun: 1, checksSkipped: 0, findings: [] }));
    return;
  }
  const [{ intro, note, outro }, { retainUpdateDoctorProcesses }, { withCommandProcessScope }] = await Promise.all([
    import(${JSON.stringify(pathToFileURL(require.resolve("@clack/prompts")).href)}),
    import(${JSON.stringify(sourceUrl("../infra/update-doctor-process-custody.ts"))}),
    import(${JSON.stringify(sourceUrl("../process/exec-spawn.ts"))}),
  ]);
  using custody = await retainUpdateDoctorProcesses();
  const run = async () => {
  if (process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION !== '0') {
    throw new Error('Update Doctor unexpectedly allowed gateway activation');
  }
  ${repairDeadline ? `if ((await fs.readFile(${JSON.stringify(path.join(process.env.OPENCLAW_STATE_DIR!, "managed-service-state"))}, 'utf8')) !== 'stopped') throw new Error('Doctor ran before the parent parked its service');` : ""}
  intro('OpenClaw doctor');
  note('Doctor panel diagnostic', 'Repair');
  if (!process.argv.includes('--no-workspace-suggestions')) note('Doctor workspace diagnostic', 'Workspace');
  console.log('Doctor console diagnostic');
  process.stderr.write('Doctor stderr diagnostic\\n');
  ${
    doctorDeadline
      ? `
  console.log('STEP completed fixture-schema');
  console.error('STEP active fixture-validation');
  process.on('SIGTERM', () => {});
  ${scenario === "doctor-progress" ? "console.error('PROGRESS fixture-validation');" : ""}
  setTimeout(() => process.exit(0), 8_000);
  await new Promise(() => {});
  `
      : ""
  }
  outro('Doctor complete.');
  ${scenario === "doctor-error" ? "throw new Error('Doctor repair failed');" : ""}
  ${
    scenario === "doctor-warning"
      ? `await fs.writeFile(process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH,
        JSON.stringify({status:'ok', warnings:['Optional probe failed; run openclaw doctor after updating.']}));`
      : ""
  }
  };
  return await (custody ? withCommandProcessScope(run, undefined, custody) : run());
}
`;
const installedEntry = path.join(root, "installed-cli.mjs");
await fs.writeFile(
  installedEntry,
  `
import fs from 'node:fs/promises';
import path from 'node:path';
${doctorSource}
async function triageCommand() {
  const contextIndex = process.argv.indexOf('--update-result');
  if (contextIndex < 0) throw new Error('Missing update failure artifact');
  await fs.readFile(process.argv[contextIndex + 1], 'utf8');
  ${scenario === "plugin-error" ? "await new Promise(resolve => setTimeout(resolve, 11_000));" : ""}
  const promptPath = path.join(process.env.OPENCLAW_STATE_DIR, 'logs', 'support', 'triage-fixture-prompt.md');
  await fs.mkdir(path.dirname(promptPath), { recursive: true });
  await fs.writeFile(promptPath, 'Synthetic update failure debugging prompt.\\n');
  const suggestedCommands = ['openclaw triage --run'];
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ promptPath, bundlePath: null, bundleError: null, findings: { error: 0, warning: 0, info: 0 }, detectedAgents: [], suggestedCommands }));
  } else {
    console.log('Debugging prompt: ' + promptPath);
    console.log('Ready-to-run agent handoffs:');
    for (const command of suggestedCommands) console.log('  ' + command);
  }
}
try {
  if (process.argv[2] === 'doctor') await doctorCommand();
  else if (process.argv.slice(2).join(' ') === 'config validate --json') {
    if (process.env.OPENCLAW_UPDATE_IN_PROGRESS !== '0') {
      throw new Error('Config validation must use strict mode');
    }
    console.log(JSON.stringify({ valid: true, path: process.env.OPENCLAW_CONFIG_PATH, warnings: [] }));
  }
  else if (process.argv[2] === 'triage') await triageCommand();
  else throw new Error('Unexpected installed CLI command: ' + process.argv[2]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
`,
);
const snapshotSource = `
const config = { update: { channel: 'dev' }, plugins: { enabled: false } };
export const readConfigFileSnapshot = async () => ({ valid: true, config, sourceConfig: config, parsed: config });
export const assertConfigWriteAllowedInCurrentMode = () => {};
`;
const stubs = new Map<string, string>();
const stub = (relative: string, source: string) => stubs.set(sourceUrl(relative), source);
const original = (relative: string) => JSON.stringify(`${sourceUrl(relative)}?fixture-original`);
function override(relative: string, source: string) {
  return stub(relative, `export * from ${original(relative)};\n${source}`);
}
// Synthetic services must not borrow the operator's shared lifecycle lock directory.
override(
  "../infra/tmp-openclaw-dir.ts",
  `
import { resolvePreferredOpenClawTmpDir as resolveOriginal } from ${original("../infra/tmp-openclaw-dir.ts")};
export const resolvePreferredOpenClawTmpDir = (options = {}) => resolveOriginal({
  ...options, preferredDir: ${JSON.stringify(path.join(root, "runtime"))},
  tmpdir: () => ${JSON.stringify(root)},
});`,
);
// Compiled import.meta.url may name a shared chunk; workers need explicit entrypoints.
for (const [relative, source] of Object.entries({
  "../infra/runtime-process-entrypoints.ts": `export const runtimeProcessEntrypoints = ${runtimeProcessEntrypointsJson};
export const SQLITE_READONLY_CHILD_ARG = ${JSON.stringify(SQLITE_READONLY_CHILD_ARG)};`,
  "../commands/doctor.ts": doctorSource,
  "../config/config.ts": snapshotSource,
  "../plugins/installed-plugin-index-records.ts":
    "export const loadInstalledPluginIndexInstallRecords = async () => ({});",
  "../plugins/plugin-lifecycle-lease.ts":
    "export const withPluginLifecycleLease = async (_options, run) => await run();",
  "./update-cli/update-command-plugins.ts": `export const updatePluginsAfterCoreUpdate = async () => ({status: ${JSON.stringify(scenario?.endsWith("plugin-error") ? "error" : scenario?.endsWith("plugin-warning") ? "warning" : "ok")}, changed: false, warnings: [], sync: {changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: []}, npm: {changed: false, outcomes: []}, integrityDrifts: []});`,
  "./update-cli/update-command-config.ts": `
import { readConfigFileSnapshot } from ${JSON.stringify(sourceUrl("../config/config.ts"))};
export const readUpdateConfigFileSnapshot = readConfigFileSnapshot;
export const capturePreUpdateSourceConfig = ({sourceConfig, parsed}) => ({ sourceConfig, authoredConfig: parsed });
export const readPostCorePreUpdateSourceConfig = async () => {
  ${scenario === "phase-hang" ? "await new Promise(resolve => setTimeout(resolve, 1_200));" : ""}
  return undefined;
};
export const persistRequestedUpdateChannel = async ({configSnapshot}) => configSnapshot;
export const persistValidatedDowngradeConfig = async () => {};
export const preparePostCorePluginConfig = async () => ({
  configSnapshot: await readConfigFileSnapshot(),
  configWriteOptions: {},
  configChanged: false,
  restoredAuthoredChannels: undefined,
});`,
})) {
  stub(relative, source);
}
// Replace snapshot creation only; keep real readers available to Doctor imports.
override(
  "./update-cli/update-command-config-snapshot.ts",
  scenario === "phase-hang"
    ? `import { spawnCommand } from ${JSON.stringify(sourceUrl("../process/exec-spawn.ts"))};
export const createUpdateConfigSnapshot = async () => {
  const child = spawnCommand([process.execPath, '-e', ${JSON.stringify(blockedChildSource)}, '--', 'fixture-private-argument'], {stdin:'pipe', stdout:'ignore', stderr:'ignore'});
  console.error('fixture configSnapshot entered');
  await child;
};`
    : scenario === "borrowed-phase"
      ? `import { advanceFinalizationFixtureClock } from ${JSON.stringify(fixtureClockUrl)};
export const createUpdateConfigSnapshot = async () => { advanceFinalizationFixtureClock(1_200); };`
      : "export const createUpdateConfigSnapshot = async () => {};",
);
override(
  "../daemon/gateway-entrypoint.ts",
  `export const resolveGatewayInstallEntrypoint = async () => ${JSON.stringify(installedEntry)};`,
);
const blockedPhase = repairDeadline
  ? "plugins"
  : doctorDeadline
    ? "doctor"
    : scenario === "phase-hang"
      ? "configSnapshot"
      : scenario === "completion-hang"
        ? "completionCache"
        : undefined;
if (blockedPhase || scenario === "borrowed-phase") {
  // Keep real phase ownership; only the deliberately blocked phase gets a short budget.
  stub(
    "./update-cli/update-finalization-lifecycle.ts",
    `import { once } from 'node:events';
import { UpdateFinalizationLifecycle as RealLifecycle } from ${original("./update-cli/update-finalization-lifecycle.ts")};
import { startFinalizationFixtureClock, restoreFinalizationFixtureClock } from ${JSON.stringify(fixtureClockUrl)};
export class UpdateFinalizationLifecycle extends RealLifecycle {
  budget(phase) { return phase === ${JSON.stringify(blockedPhase)} ? 1_000 : super.budget(phase); }
  ${
    scenario === "phase-hang"
      ? `run(phase, operation, outcome, custody) {
    if (phase !== 'configSnapshot') return super.run(phase, operation, outcome, custody);
    return super.run(phase, operation, outcome, {
      ...custody,
      enter: async () => {
        await custody?.enter?.();
        const released = once(process.stdin, 'end');
        process.stdin.resume();
        console.error('fixture configSnapshot recorded');
        await released;
      },
    });
  }`
      : doctorDeadline || scenario === "borrowed-phase"
        ? `async run(phase, operation, outcome, custody) {
    if (phase !== 'doctor' && !(phase === 'configSnapshot' && ${scenario === "borrowed-phase"})) return super.run(phase, operation, outcome, custody);
    startFinalizationFixtureClock();
    try { return await super.run(phase, operation, outcome, custody); }
    finally { restoreFinalizationFixtureClock(); }
  }`
        : ""
  }
}`,
  );
}
if (doctorDeadline || scenario === "borrowed-phase") {
  override(
    "./update-cli/update-finalization-output.ts",
    `
import { captureUpdateFinalizationDoctorOutput as capture } from ${original("./update-cli/update-finalization-output.ts")};
import { advanceFinalizationFixtureClock, restoreFinalizationFixtureClock } from ${JSON.stringify(fixtureClockUrl)};
export function captureUpdateFinalizationDoctorOutput(phase) {
  const append = capture(phase);
  const output = { stdout: '', stderr: '' };
  let ready = false;
  return append && ((chunk, stream) => {
    append(chunk, stream);
    output[stream] += chunk.toString();
    if (!ready && ${
      doctorDeadline
        ? `output.stdout.includes('STEP completed fixture-schema') && output.stderr.includes(${JSON.stringify(scenario === "doctor-progress" ? "PROGRESS fixture-validation" : "STEP active fixture-validation")})`
        : "output.stdout.includes('Doctor complete.')"
    }) {
      ready = true;
      ${doctorDeadline ? "advanceFinalizationFixtureClock(1_000);" : "restoreFinalizationFixtureClock();"}
    }
  });
}`,
  );
}
if (scenario === "human-recovery-plugin-error") {
  override(
    "../commands/configure.shared.ts",
    `
import { mock } from 'node:test';
import { defaultRuntime } from ${JSON.stringify(sourceUrl("../runtime.ts"))};
export async function select() {
  mock.timers.tick(11_000);
  console.error('Fixture advanced watchdog clock.');
  defaultRuntime.log('Interactive recovery completed.');
  return 'dismiss';
}`,
  );
}
if (scenario === "doctor-error") {
  // Model a loaded runner's next port read without a real delay. Recovery must
  // exhaust this fixture's polling budget in the interval, before another read.
  override(
    "../infra/ports-inspect.ts",
    `
import { inspectPortUsage as inspectOriginal } from ${original("../infra/ports-inspect.ts")};
import { elapsed, sleep } from ${JSON.stringify(recoveryClockUrl)};
export async function inspectPortUsage(port, options) {
  const usage = await inspectOriginal(port, options);
  if (elapsed > 0) await sleep(3_600_000, options?.signal);
  return usage;
}`,
  );
  // The timeout-report case owns an uninspectable service, not the host's manager.
  // Admit that fixture identity while leaving recovery inspection, HTTP probes,
  // polling, and failure recording real; no service mutation is permitted.
  override("../config/paths.ts", "export const isDefaultInstallIdentity = () => true;");
  override(
    "../daemon/service.ts",
    `
const refuseMutation = async () => { throw new Error('Output fixture cannot mutate a Gateway service'); };
const service = {
  label: 'Fixture service', loadedText: 'loaded', notLoadedText: 'not loaded',
  isLoaded: async () => { throw new Error('Fixture service status unavailable'); },
  readCommand: async () => null,
  readRuntime: async () => ({ status: 'unknown' }),
  stage: refuseMutation, install: refuseMutation, uninstall: refuseMutation,
  start: refuseMutation, stop: refuseMutation, restart: refuseMutation,
};
export const resolveGatewayService = () => service;`,
  );
}
if (repairDeadline) {
  const { prepareRepairDeadlineFixture } =
    await import("./update-finalization-repair.test-support.js");
  await prepareRepairDeadlineFixture(
    stubs,
    sourceUrl,
    root,
    installedEntry,
    scenario === "repair-deadline-starting"
      ? "starting"
      : scenario === "repair-deadline-failed"
        ? "failed"
        : "ready",
  );
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") || specifier.startsWith("file:")) {
      const resolved = new URL(specifier, context.parentURL).href;
      const url = import.meta.url.endsWith(".js") ? resolved : resolved.replace(/\.js$/u, ".ts");
      const recoverySleepUrl = recoveryClockUrls.get(context.parentURL ?? "");
      if (
        [sourceUrl("../utils.ts"), sourceUrl("../utils/sleep.ts")].includes(url) &&
        recoverySleepUrl
      ) {
        return { url: recoverySleepUrl, shortCircuit: true };
      }
      const source = stubs.get(url);
      if (source !== undefined) {
        return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

if (repairDeadline) {
  const { withPluginLifecycleLease } = await import("../plugins/plugin-lifecycle-lease.js");
  await withPluginLifecycleLease({}, async () => {});
}

const { Command } = await import("commander");
const { registerUpdateCli } = await import("./update-cli.js");
const { defaultRuntime } = await import("../runtime.js");
const { formatCliJsonFailure } = await import("./failure-output.js");
const { runCliWithExitFinalization } = await import("./one-shot-exit.js");
const { withCliProcessScope } = await import("./runtime-cleanup-scope.js");
const { enableConsoleCapture } = await import("../logging/console.js");
const { withConsoleLogsRoutedToStderrForJson, applyResolvedCommandOutputMode } =
  await import("./json-output-mode.js");
const { isCommandJsonOutputMode } = await import("./program/json-mode.js");
if (scenario === "human-recovery-plugin-error" || scenario === "borrowed-output") {
  mock.timers.enable({ apis: ["setTimeout"] });
}
process.argv = [process.execPath, path.join(root, "openclaw.mjs"), ...args];
enableConsoleCapture();
const run = () =>
  withConsoleLogsRoutedToStderrForJson(
    process.argv,
    async () => {
      const program = new Command().name("openclaw");
      program.hook("preAction", (_root, command) => {
        applyResolvedCommandOutputMode(isCommandJsonOutputMode(command));
      });
      registerUpdateCli(program);
      await program.parseAsync(process.argv);
      if (scenario === "handle-hang") {
        const { spawn } = await import("node:child_process");
        const { runCliDisposer } = await import("./runtime-cleanup.js");
        const child = spawn(
          process.execPath,
          ["-e", blockedChildSource, "--", "fixture-private-argument"],
          {
            stdio: ["pipe", "ignore", "ignore"],
          },
        );
        // The fixture owns this child, not the completed update operation. Release
        // it only after the parent has observed the real stall diagnostic.
        process.stdin.once("end", () => child.stdin.end());
        process.stdin.resume();
        await runCliDisposer(
          "fixture-stdin-child",
          () =>
            new Promise<void>((resolve) => {
              child.once("close", () => resolve());
            }),
        );
      }
      if (borrowed) {
        if (scenario === "borrowed-output") {
          mock.timers.tick(11_000);
          console.error("Fixture advanced watchdog clock.");
        }
        console.error("Borrowed caller completed.");
      }
    },
    { retainRoutingUntilProcessExit: true },
  );
if (borrowed) {
  await run();
} else {
  await runCliWithExitFinalization({
    run: () => withCliProcessScope(run),
    onError: (error) => {
      defaultRuntime.writeJson(formatCliJsonFailure(error));
      process.exitCode = 1;
    },
  });
}
