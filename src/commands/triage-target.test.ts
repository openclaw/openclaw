import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createExternalAuthRuntime } from "../agents/auth-profiles/external-auth.js";
import { createAuthProfileStoreRuntime } from "../agents/auth-profiles/store.js";
import {
  resolveExecPreparedRunEnvironment,
  resolvePreparedExecEnvironment,
} from "../agents/bash-tools.exec-request-preparation.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { resolveExecToolConfig } from "../agents/lazy-exec-tool.js";
import {
  getRuntimeConfig,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/io.js";
import { pinRuntimePaths, resolveStateDir } from "../config/paths.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import { sanitizeHostExecEnv } from "../infra/host-env-security.js";
import {
  getInstallationTarget,
  resolveInstallationTarget,
  withInstallationTarget,
} from "../infra/installation-target-context.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { triageTestRuntimeEntrypoints } from "../infra/triage-runtime.test-support.js";
import { runUpdateRepairLoop } from "../infra/update-repair-agent.js";
import * as repairRuntime from "../infra/update-repair-agent.runtime.js";
import { runUpdateRepairTurn } from "../infra/update-repair-agent.runtime.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as agentExec from "./agent-exec.js";
import { renderTriagePrompt } from "./triage-prompt.js";
import { triageCommand } from "./triage.js";

const mocks = vi.hoisted(() => ({
  collectDoctorFindings: vi.fn(),
  writeDiagnosticSupportExport: vi.fn(),
  agentCommand: vi.fn(),
  runEmbeddedAgent: vi.fn(),
  runEmbeddedAgentEntry: vi.fn(),
}));

// Diagnostics are fixture leaves; triage, exec, config, env filtering,
// and child processes stay real so the handoff cannot hide behind an exec mock.
vi.mock("./doctor-lint-runner.js", () => ({ collectDoctorFindings: mocks.collectDoctorFindings }));
vi.mock("../logging/diagnostic-support-export.js", () => ({
  writeDiagnosticSupportExport: mocks.writeDiagnosticSupportExport,
}));
vi.mock("./agent.js", () => ({ agentCommand: mocks.agentCommand }));
vi.mock("../agents/embedded-agent.js", () => ({ runEmbeddedAgent: mocks.runEmbeddedAgent }));
vi.mock("../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: mocks.runEmbeddedAgentEntry,
}));

const execFileAsync = promisify(execFile);
const pathsModuleUrl = resolveRuntimeWorkerUrl(triageTestRuntimeEntrypoints.paths).href;
const workspaceModuleUrl = resolveRuntimeWorkerUrl(
  triageTestRuntimeEntrypoints.workspaceDefault,
).href;
const tsxApiUrl = import.meta.resolve("tsx/esm/api");
const tsconfigPath = path.resolve(import.meta.dirname, "../../tsconfig.json");
const marker = "synthetic-original-installation";
const secret = "sk-test-triage-target-synthetic-secret-1234567890";

type ChildTarget = {
  stateDir: string;
  configPath: string;
  configExists: boolean;
  marker?: string;
  defaultWorkspaceDir: string;
  workspaceMarker?: string;
};

async function inspectChildTarget(env: NodeJS.ProcessEnv, cwd: string): Promise<ChildTarget> {
  // Load only the real CLI path owner, never a CLI entrypoint, Doctor, or an agent.
  const source = `
    import { existsSync, readFileSync } from "node:fs";
    import path from "node:path";
    const unregister = ${JSON.stringify(pathsModuleUrl.endsWith(".ts"))}
      ? (await import(${JSON.stringify(tsxApiUrl)})).register({ tsconfig: ${JSON.stringify(tsconfigPath)} })
      : undefined;
    const { resolveStateDir, resolveConfigPath } = await import(${JSON.stringify(pathsModuleUrl)});
    const { resolveDefaultAgentWorkspaceDir } = await import(${JSON.stringify(workspaceModuleUrl)});
    const stateDir = resolveStateDir();
    const configPath = resolveConfigPath();
    const defaultWorkspaceDir = resolveDefaultAgentWorkspaceDir();
    const workspaceMarkerPath = path.join(defaultWorkspaceDir, "workspace-probe.txt");
    process.stdout.write(JSON.stringify({ stateDir, configPath, configExists: existsSync(configPath), marker: existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")).meta?.lastTouchedVersion : undefined, defaultWorkspaceDir, workspaceMarker: existsSync(workspaceMarkerPath) ? readFileSync(workspaceMarkerPath, "utf8") : undefined }));
    await unregister?.();
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    { cwd, env, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 },
  );
  return JSON.parse(stdout) as ChildTarget;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  pinRuntimePaths();
});

describe.skipIf(process.platform === "win32")("embedded triage installation target", () => {
  it.each([false, true])(
    "scopes prompt-free repair to its target (candidate=%s) while preserving policy and auth",
    async (candidate) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const config: OpenClawConfig = {
          auth: { order: { fixture: ["preferred", "backup"] } },
          tools: {
            profile: candidate ? "minimal" : "coding",
            allow: ["group:runtime", "group:fs", "browser"],
            deny: ["browser"],
            alsoAllow: ["group:runtime", "group:fs", "browser"],
            exec: { mode: "ask", safeBins: ["cat"] },
            fs: { workspaceOnly: true },
            byProvider: {
              fixture: { deny: ["browser"] },
              "fixture/blocked": { deny: ["write"] },
              "blocked-provider": { deny: ["edit"] },
            },
          },
          agents: {
            defaults: { systemAgent: { agentId: "diagnostic" } },
            entries: {
              diagnostic: {
                model: "fixture/repair@preferred",
                tools: { exec: { mode: "ask", safeBins: ["sed"] }, deny: ["browser"] },
              },
            },
          },
        };
        const candidateRoot = state.path("candidate");
        await fs.mkdir(candidateRoot);
        const root = candidate ? candidateRoot : state.workspaceDir;
        const agentDir = state.statePath("agents", "diagnostic", "agent");
        mocks.runEmbeddedAgentEntry.mockImplementation(
          async (params: {
            selection: {
              provider: string;
              model: string;
              agentDir: string;
              userLockedAuthProfileId: string;
              fallbacksOverride: string[];
            };
            runCandidate: (
              provider: string,
              model: string,
              options: { agentHarnessRuntimeOverride: string },
            ) => Promise<unknown>;
          }) => {
            expect(params.selection).toMatchObject({
              provider: "fixture",
              model: "repair",
              agentDir,
              userLockedAuthProfileId: "preferred",
              fallbacksOverride: ["fixture/fallback"],
            });
            const { provider, model } = params.selection;
            const result = await params.runCandidate(provider, model, {
              agentHarnessRuntimeOverride: "openclaw",
            });
            return { result, provider, model, terminal: { outcome: { status: "ok" } } };
          },
        );
        mocks.runEmbeddedAgent.mockImplementation(async (opts: RunEmbeddedAgentParams) => {
          const runConfig = opts.config!;
          expect(opts.workspaceDir).toBe(root);
          expect(opts.cwd).toBe(root);
          expect(opts.modelFallbacksOverride).toEqual(["fixture/fallback"]);
          expect(opts.agentDir).toBe(agentDir);
          expect(opts.authProfileId).toBe("preferred");
          expect(opts.authProfileIdSource).toBe("user");
          expect(opts.sessionPersistence).toBe("detached");
          expect(getInstallationTarget()).toEqual({
            stateDir: state.stateDir,
            configPath: state.configPath,
            defaultWorkspaceDir: state.workspaceDir,
          });
          expect(runConfig.agents?.entries?.diagnostic?.workspace).toBe(root);
          expect(runConfig.tools?.fs?.workspaceOnly).toBe(true);
          expect(runConfig.agents?.entries?.diagnostic?.tools?.fs?.workspaceOnly).toBe(true);
          expect(runConfig.tools?.exec).toMatchObject({ mode: "full", safeBins: ["cat"] });
          expect(runConfig.agents?.entries?.diagnostic?.tools?.exec).toMatchObject({
            mode: "full",
            safeBins: ["sed"],
          });
          expect(runConfig.tools?.allow).toEqual([
            "exec",
            "process",
            "read",
            "write",
            "edit",
            "apply_patch",
          ]);
          expect(runConfig.tools?.alsoAllow).toEqual(runConfig.tools?.allow);
          expect(runConfig.tools?.deny).toEqual(["browser"]);
          expect(runConfig.agents?.entries?.diagnostic?.tools?.deny).toEqual(["browser"]);
          expect(runConfig.tools?.byProvider).toEqual(config.tools?.byProvider);
          expect(resolveExecToolConfig({ cfg: runConfig, agentId: "diagnostic" })).toMatchObject({
            mode: "full",
            security: "full",
            ask: "off",
            safeBins: ["sed"],
          });
          expect(runConfig.auth).toEqual(config.auth);
          expect(runConfig.agents?.entries?.diagnostic?.model).toBe("fixture/repair@preferred");
          return { payloads: [{ text: "Fixture completed." }], meta: { durationMs: 1 } };
        });
        const result = await runUpdateRepairTurn({
          target: {
            stateDir: state.stateDir,
            configPath: state.configPath,
            workspaceDir: state.workspaceDir,
            installRoot: root,
          },
          route: {
            runner: "embedded",
            provider: "fixture",
            model: "repair",
            modelLabel: "fixture/repair",
            authProfileId: "preferred",
            agentId: "diagnostic",
            agentDir,
            runConfig: config,
            sourceConfig: config,
          },
          modelFallbacks: ["fixture/blocked", "blocked-provider/model", "fixture/fallback"],
          prompt: "Check the installation.",
          timeoutMs: 30_000,
          maxToolCalls: 1,
          signal: new AbortController().signal,
        });
        expect(result.status).toBe("completed");
        if (result.status !== "completed") {
          throw new Error(result.reason);
        }
        expect(result.envelope.error).toBeUndefined();
        expect(result.envelope.status).toBe("ok");
        expect(mocks.runEmbeddedAgentEntry).toHaveBeenCalledOnce();
        expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
        expect(mocks.agentCommand).not.toHaveBeenCalled();
      });
    },
  );
  it.each<{ name: string; tools?: OpenClawConfig["tools"]; agentTools?: AgentToolsConfig }>([
    { name: "global exec mode", tools: { exec: { mode: "deny" as const } } },
    { name: "agent exec mode", agentTools: { exec: { mode: "deny" as const } } },
    { name: "legacy exec security", agentTools: { exec: { security: "deny" as const } } },
    ...["exec", "write", "edit", "apply_patch"].map((tool) => ({
      name: `denied ${tool}`,
      tools: { deny: [tool] },
    })),
    { name: "agent tool deny", agentTools: { deny: ["exec"] } },
    { name: "tool group deny", tools: { deny: ["group:runtime"] } },
    { name: "explicit allow", tools: { allow: ["read"] } },
    { name: "provider deny", tools: { byProvider: { fixture: { deny: ["exec"] } } } },
  ])("reports $name as unavailable without an agent turn", async ({ tools, agentTools }) => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const config: OpenClawConfig = {
        tools,
        agents: {
          defaults: { systemAgent: { agentId: "diagnostic" } },
          entries: { diagnostic: { tools: agentTools } },
        },
      };
      vi.spyOn(repairRuntime, "prepareUpdateRepairInference").mockResolvedValue({
        ok: true,
        route: {
          runner: "embedded",
          provider: "fixture",
          model: "repair",
          modelLabel: "fixture/repair",
          agentId: "diagnostic",
          agentDir: state.statePath("agents", "diagnostic", "agent"),
          runConfig: config,
          sourceConfig: config,
        },
        modelFallbacks: [],
      });
      mocks.runEmbeddedAgent.mockResolvedValue({
        payloads: [{ text: "Should not run" }],
        meta: { durationMs: 1 },
      });
      const result = await runUpdateRepairLoop({
        target: {
          stateDir: state.stateDir,
          configPath: state.configPath,
          workspaceDir: state.workspaceDir,
          installRoot: state.workspaceDir,
        },
        context: { error: "Synthetic failure", phase: "validating" },
        validate: async () => ({ ok: false, score: -1, summary: "Synthetic failure" }),
      });
      expect(result).toMatchObject({
        status: "unavailable",
        reason: "exec-denied-by-policy",
        attempts: [],
      });
      expect(mocks.runEmbeddedAgentEntry).not.toHaveBeenCalled();
      expect(mocks.runEmbeddedAgent).not.toHaveBeenCalled();
      expect(mocks.agentCommand).not.toHaveBeenCalled();
    });
  });
  it.each([
    { name: "sandbox all", agent: { sandbox: { mode: "all" as const } } },
    { name: "sandbox non-main", agent: { sandbox: { mode: "non-main" as const } } },
    { name: "node", agent: { tools: { exec: { host: "node" as const } } } },
    { name: "explicit sandbox", agent: { tools: { exec: { host: "sandbox" as const } } } },
  ])("refuses $name before the fixing turn, without changing ordinary exec", async ({ agent }) => {
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "diagnostic" } },
          entries: { diagnostic: agent },
        },
      };
      setRuntimeConfigSnapshot(config);
      const runAgent = vi.fn(async () => ({
        payloads: [{ text: "fixture completed" }],
        meta: { durationMs: 1 },
      }));
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const target = resolveInstallationTarget();
      const result = await withInstallationTarget(target, () =>
        agentExec.agentExecCommand("inspect", { cwd: state.workspaceDir }, runtime, { runAgent }),
      );
      expect(result.exitCode).toBe(1);
      expect(result.envelope.error?.message).toContain("saved prompt");
      expect(runAgent).not.toHaveBeenCalled();
      expect(getInstallationTarget()).toBeUndefined();
      expect(getRuntimeConfigSnapshot()).toBe(config);
      const ordinary = await agentExec.agentExecCommand(
        "inspect",
        { cwd: state.workspaceDir },
        runtime,
        { runAgent },
      );
      expect(ordinary.exitCode).toBe(0);
      expect(runAgent).toHaveBeenCalledOnce();
    });
  });
  it.each([
    {
      layout: "split" as const,
      fails: false,
      workspaceSelector: "custom",
      automatic: false,
      route: "ordinary agent exec",
    },
    {
      layout: "home" as const,
      fails: false,
      workspaceSelector: "default",
      automatic: false,
      route: "ordinary agent exec",
    },
    {
      layout: "split" as const,
      fails: true,
      workspaceSelector: "default",
      automatic: false,
      route: "ordinary agent exec",
    },
    {
      layout: "split" as const,
      fails: false,
      workspaceSelector: "custom",
      automatic: true,
      route: "automatic shared OAuth recovery",
    },
    {
      layout: "home" as const,
      fails: true,
      workspaceSelector: "default",
      automatic: true,
      route: "automatic shared OAuth recovery",
    },
  ])(
    "keeps the $layout installation and $workspaceSelector workspace addressable ($route, fails=$fails)",
    async ({ layout, fails, workspaceSelector, automatic }) => {
      const previousSnapshot = getRuntimeConfigSnapshot();
      const temporaryRoot = os.tmpdir();
      // Clear inherited credentials and selectors through the tracked helper. Only
      // synthetic paths and a fake provider key reach the production env boundary.
      const syntheticEnv: Record<string, string | undefined> = Object.fromEntries(
        Object.keys(process.env).map((key) => [key, undefined]),
      );
      Object.assign(syntheticEnv, {
        PATH: "/usr/bin:/bin",
        TMPDIR: temporaryRoot,
        TMP: temporaryRoot,
        TEMP: temporaryRoot,
        VITEST: "true",
        NODE_ENV: "test",
        OPENAI_API_KEY: secret,
        OPENCLAW_WORKSPACE_DIR: undefined,
        ...(automatic
          ? {
              OPENCLAW_SERVICE_REPAIR_POLICY: "update",
              OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "1",
            }
          : {}),
      });
      try {
        await withEnvAsync(syntheticEnv, async () => {
          await withOpenClawTestState(
            {
              layout,
              label: "triage-target",
              ...(layout === "home"
                ? { env: { OPENCLAW_STATE_DIR: undefined, OPENCLAW_CONFIG_PATH: undefined } }
                : {}),
            },
            async (state) => {
              vi.spyOn(process, "cwd").mockReturnValue(state.workspaceDir);
              const executionRoot = automatic
                ? state.path("owned installation")
                : state.workspaceDir;
              await fs.mkdir(executionRoot, { recursive: true });
              const defaultWorkspaceDir =
                workspaceSelector === "custom"
                  ? state.path("custom default workspace")
                  : state.statePath("workspace");
              if (workspaceSelector === "custom") {
                process.env.OPENCLAW_WORKSPACE_DIR = defaultWorkspaceDir;
              }
              await fs.mkdir(defaultWorkspaceDir, { recursive: true });
              const workspaceMarkerPath = path.join(defaultWorkspaceDir, "workspace-probe.txt");
              await fs.writeFile(workspaceMarkerPath, marker);
              const terminalDescriptors = [process.stdin, process.stdout].map((stream) =>
                Object.getOwnPropertyDescriptor(stream, "isTTY"),
              );
              for (const stream of [process.stdin, process.stdout]) {
                Object.defineProperty(stream, "isTTY", { configurable: true, value: !automatic });
              }
              try {
                const config: OpenClawConfig = {
                  meta: { lastTouchedVersion: marker },
                  agents: {
                    ownership: "explicit",
                    defaults: { systemAgent: { agentId: "diagnostic" } },
                    entries: {
                      diagnostic: {
                        model: "fixture/diagnostic-model",
                        ...(automatic ? {} : { runtime: { type: "acp" as const } }),
                      },
                    },
                  },
                  env: { shellEnv: { enabled: false } },
                  plugins: { enabled: false },
                  gateway: { auth: { mode: "token", token: secret } },
                };
                await state.writeConfig(config);
                const agentDir = state.statePath("agents", "diagnostic", "agent");
                const profileId = "fixture:subscription";
                const auth = createAuthProfileStoreRuntime(createExternalAuthRuntime(() => []));
                if (automatic) {
                  auth.saveAuthProfileStore({
                    version: 1,
                    profiles: {
                      [profileId]: {
                        type: "oauth",
                        provider: "fixture",
                        access: "synthetic-shared-oauth-access",
                        refresh: "synthetic-shared-oauth-refresh",
                        expires: Date.now() + 3_600_000,
                      },
                    },
                  });
                  vi.spyOn(repairRuntime, "prepareUpdateRepairInference").mockResolvedValue({
                    ok: true,
                    route: {
                      runner: "embedded",
                      agentId: "diagnostic",
                      agentDir,
                      provider: "fixture",
                      model: "diagnostic-model",
                      modelLabel: "fixture/diagnostic-model",
                      authProfileId: profileId,
                      runConfig: config,
                      sourceConfig: config,
                    },
                    modelFallbacks: [],
                  });
                  mocks.runEmbeddedAgentEntry.mockImplementation(
                    async (params: {
                      selection: { provider: string; model: string };
                      runCandidate: (
                        provider: string,
                        model: string,
                        options: { agentHarnessRuntimeOverride: string },
                      ) => Promise<unknown>;
                    }) => {
                      const { provider, model } = params.selection;
                      const result = await params.runCandidate(provider, model, {
                        agentHarnessRuntimeOverride: "openclaw",
                      });
                      return { result, provider, model, terminal: { outcome: { status: "ok" } } };
                    },
                  );
                }
                const originalConfig = await fs.readFile(state.configPath, "utf8");
                const archivePath = state.statePath("logs", "support", "installation.zip");
                const archive = await new JSZip()
                  .file("installation.txt", marker)
                  .generateAsync({ type: "nodebuffer" });
                await fs.mkdir(path.dirname(archivePath), { recursive: true });
                await fs.writeFile(archivePath, archive);
                const findings = [
                  {
                    checkId: "fixture/installation",
                    severity: "warning",
                    message: `Synthetic diagnostic; Authorization: Bearer ${secret}`,
                  },
                ] as const;
                mocks.collectDoctorFindings.mockResolvedValue(findings);
                mocks.writeDiagnosticSupportExport.mockResolvedValue({ path: archivePath });
                const target = resolveInstallationTarget();
                const observedTargets: Record<
                  string,
                  ReturnType<typeof getInstallationTarget>
                > = {};
                const runtime = {
                  log: vi.fn(),
                  error: vi.fn(),
                  exit: vi.fn(),
                  writeStdout: vi.fn(),
                };
                const execSpy = vi.spyOn(agentExec, "agentExecCommand");
                const before = await inspectChildTarget(sanitizeHostExecEnv(), state.workspaceDir);
                expect(before).toEqual({
                  stateDir: state.stateDir,
                  configPath: state.configPath,
                  configExists: true,
                  marker,
                  defaultWorkspaceDir,
                  workspaceMarker: marker,
                });
                if (layout === "split") {
                  expect(path.dirname(state.configPath)).not.toBe(state.stateDir);
                }
                const originalSelectors = {
                  stateDir: process.env.OPENCLAW_STATE_DIR,
                  configPath: process.env.OPENCLAW_CONFIG_PATH,
                  workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR,
                };

                let runStateDir = "";
                let shellLookup = "";
                let childTarget: ChildTarget | undefined;
                const controller = new AbortController();
                const assertCurrent = vi.fn();
                const runFailure = new Error("synthetic run failure");
                const inspectRun = async (opts: {
                  prompt: string;
                  config: OpenClawConfig;
                  agentId: string | undefined;
                  sessionId: string;
                  abortSignal?: AbortSignal;
                  assertSourceCurrent?: () => void;
                }) => {
                  observedTargets.repair = getInstallationTarget();
                  const prompt = opts.prompt;
                  const archiveReference = /^Sanitized ZIP: (.+)$/mu.exec(prompt)?.[1];
                  expect(archiveReference).toBe(
                    "$OPENCLAW_STATE_DIR/logs/support/installation.zip",
                  );
                  expect(prompt).not.toContain(secret);
                  expect(prompt).not.toContain(state.stateDir);
                  expect(prompt).not.toContain(defaultWorkspaceDir);
                  expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(8 * 1024);
                  runStateDir = await fs.realpath(resolveStateDir());
                  if (automatic) {
                    expect(runStateDir).toBe(state.stateDir);
                    expect(process.env.OPENCLAW_SERVICE_REPAIR_POLICY).toBe("update");
                    expect(process.env.OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION).toBe("1");
                  } else {
                    expect(runStateDir).not.toBe(state.stateDir);
                    expect(process.env.OPENCLAW_WORKSPACE_DIR).toBe(executionRoot);
                  }
                  const runConfig = opts.config;
                  expect(runConfig.agents?.entries?.diagnostic?.workspace).toBe(executionRoot);
                  expect(runConfig.agents?.entries?.diagnostic?.model).toBe(
                    "fixture/diagnostic-model",
                  );
                  if (!automatic) {
                    const sessionStore = resolveSessionStorePathCore(runConfig.session?.store, {
                      agentId: String(opts.agentId),
                    });
                    expect(sessionStore).toBe(
                      path.join(runStateDir, "agents", "diagnostic", "sessions", "sessions.json"),
                    );
                  }
                  expect(opts.sessionId).toEqual(expect.any(String));
                  // Exercise the same preparation and projection used by built-in exec;
                  // no installation selectors are supplied by the probe itself.
                  const prepared = resolveExecPreparedRunEnvironment({
                    config: runConfig,
                    agentId: "diagnostic",
                  });
                  const { env: toolEnv } = resolvePreparedExecEnvironment({
                    execParams: { command: "synthetic read-only target probes" },
                    host: "gateway",
                    defaultPathPrepend: [],
                    warnings: [],
                    ...prepared,
                  });
                  expect(toolEnv.OPENAI_API_KEY).toBeUndefined();
                  const shell = await execFileAsync(
                    "/bin/sh",
                    [
                      "-c",
                      `archive="${archiveReference}"; printf '%s\\n' "$archive"; if [ -f "$archive" ]; then printf 'present\\n'; else printf 'missing\\n'; fi`,
                    ],
                    { env: toolEnv, cwd: executionRoot, encoding: "utf8", timeout: 10_000 },
                  );
                  shellLookup = shell.stdout;
                  childTarget = await inspectChildTarget(toolEnv, executionRoot);
                  if (automatic) {
                    const runSignal = opts.abortSignal!;
                    expect(runSignal.aborted).toBe(false);
                    const checksBefore = assertCurrent.mock.calls.length;
                    opts.assertSourceCurrent?.();
                    expect(assertCurrent.mock.calls.length).toBeGreaterThan(checksBefore);
                    expect(prompt).toContain("## Triggering failure");
                    expect(prompt).toContain("openclaw health --json");
                    if (fails) {
                      controller.abort(runFailure);
                      expect(runSignal.aborted).toBe(true);
                      expect(runSignal.reason).toBe(runFailure);
                      runSignal.throwIfAborted();
                    }
                  }
                  if (fails) {
                    throw runFailure;
                  }
                  return {
                    payloads: [{ text: "Synthetic boundary probes completed." }],
                    meta: { durationMs: 1 },
                  };
                };
                if (automatic) {
                  mocks.runEmbeddedAgent.mockImplementation(
                    async (opts: RunEmbeddedAgentParams) => {
                      expect(opts.agentDir).toBe(agentDir);
                      expect(opts.authProfileId).toBe(profileId);
                      expect(opts.authProfileIdSource).toBe("user");
                      expect(opts.sessionPersistence).toBe("detached");
                      expect(opts.sessionManager?.getSessionTarget()).toBeUndefined();
                      expect(opts.cwd).toBe(executionRoot);
                      expect(opts.workspaceDir).toBe(executionRoot);
                      expect(
                        auth.loadAuthProfileStoreForRuntime(opts.agentDir, {
                          readOnly: true,
                          externalCli: { mode: "none" },
                        }).profiles[profileId],
                      ).toMatchObject({ type: "oauth", access: "synthetic-shared-oauth-access" });
                      return inspectRun({
                        prompt: opts.prompt,
                        config: opts.config!,
                        agentId: opts.agentId,
                        sessionId: opts.sessionId,
                        abortSignal: opts.abortSignal,
                        assertSourceCurrent: opts.preparedRunAdmission?.assertSourceCurrent,
                      });
                    },
                  );
                }
                mocks.agentCommand.mockImplementation(async (opts) =>
                  inspectRun({
                    prompt: opts.message,
                    config: getRuntimeConfig(),
                    agentId: opts.agentId,
                    sessionId: opts.sessionId,
                    abortSignal: opts.abortSignal,
                    assertSourceCurrent: opts.assertSourceCurrent,
                  }),
                );

                const run = automatic
                  ? triageCommand(
                      runtime,
                      {},
                      {
                        failure: {
                          kind: "update",
                          phase: "restart-unhealthy",
                          error: `Synthetic startup failure; Authorization: Bearer ${secret}`,
                          installationRoot: executionRoot,
                          expectedVersion: marker,
                          gateway: "verify-running",
                        },
                        signal: controller.signal,
                        assertCurrent,
                      },
                    )
                  : withInstallationTarget(target, () =>
                      agentExec.agentExecCommand(
                        renderTriagePrompt({
                          findings,
                          bundle: { kind: "available", path: archivePath },
                          redaction: { env: process.env, stateDir: state.stateDir },
                        }),
                        { cwd: executionRoot },
                        runtime,
                      ),
                    );
                if (automatic) {
                  if (fails) {
                    await expect(run).rejects.toMatchObject({ code: 1 });
                  } else {
                    await run;
                  }
                } else {
                  expect(await run).toMatchObject({ exitCode: fails ? 1 : 0 });
                }

                expect(runtime.error.mock.calls).toEqual(fails ? [["synthetic run failure"]] : []);
                expect(runtime.exit.mock.calls).toEqual(fails && automatic ? [[1]] : []);
                expect(getInstallationTarget()).toBeUndefined();
                expect(observedTargets).toEqual({ repair: target });
                if (automatic) {
                  expect(mocks.runEmbeddedAgent).toHaveBeenCalledOnce();
                  expect(execSpy).not.toHaveBeenCalled();
                  expect(mocks.agentCommand).not.toHaveBeenCalled();
                } else {
                  expect(mocks.agentCommand).toHaveBeenCalledOnce();
                  expect(execSpy).toHaveBeenCalledOnce();
                  expect(execSpy.mock.calls[0]?.[1].stateDir).toBeUndefined();
                  expect(execSpy.mock.calls[0]?.[1].cwd).toBe(executionRoot);
                }
                expect(process.env.OPENCLAW_STATE_DIR).toBe(originalSelectors.stateDir);
                expect(process.env.OPENCLAW_CONFIG_PATH).toBe(originalSelectors.configPath);
                expect(process.env.OPENCLAW_WORKSPACE_DIR).toBe(originalSelectors.workspaceDir);
                expect(getRuntimeConfigSnapshot()).toBeNull();
                if (automatic) {
                  expect((await fs.stat(runStateDir)).isDirectory()).toBe(true);
                } else {
                  await expect(fs.stat(runStateDir)).rejects.toMatchObject({ code: "ENOENT" });
                }
                expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
                expect(await fs.readFile(archivePath)).toEqual(archive);
                expect(await fs.readFile(workspaceMarkerPath, "utf8")).toBe(marker);
                expect(JSON.stringify(runtime.log.mock.calls)).not.toContain(secret);

                // Assert after execution cleanup so failed turns preserve the
                // installation and both shell/child target boundaries.
                expect
                  .soft(shellLookup, "shell must find the archive named in the model prompt")
                  .toBe(`${archivePath}\npresent\n`);
                expect
                  .soft(
                    childTarget,
                    "child OpenClaw must select the original config and default workspace",
                  )
                  .toEqual(before);
              } finally {
                for (const [index, stream] of [process.stdin, process.stdout].entries()) {
                  const descriptor = terminalDescriptors[index];
                  if (descriptor) {
                    Object.defineProperty(stream, "isTTY", descriptor);
                  } else {
                    Reflect.deleteProperty(stream, "isTTY");
                  }
                }
                vi.restoreAllMocks();
              }
            },
          );
        });
      } finally {
        if (previousSnapshot) {
          setRuntimeConfigSnapshot(previousSnapshot);
        }
        pinRuntimePaths();
      }
    },
  );
});
