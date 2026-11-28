import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { AgentEntryConfig } from "../config/types.agents.js";
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
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as agentExec from "./agent-exec.js";
import { renderTriagePrompt } from "./triage-prompt.js";
import { createTriageRuntime, withTriageTerminal } from "./triage.test-support.js";

const mocks = vi.hoisted(() => ({
  agentCommand: vi.fn(),
  runEmbeddedAgent: vi.fn(),
  runEmbeddedAgentEntry: vi.fn(),
}));

// Exec, config, env filtering and child processes stay real.
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

function agentConfig(agent: AgentEntryConfig, config: OpenClawConfig = {}): OpenClawConfig {
  return {
    ...config,
    agents: {
      ...config.agents,
      defaults: { systemAgent: { agentId: "diagnostic" } },
      entries: { diagnostic: agent },
    },
  };
}

function repairFixture(
  state: OpenClawTestState,
  config: OpenClawConfig,
  installRoot = state.workspaceDir,
) {
  const { stateDir, configPath, workspaceDir } = state;
  return {
    target: { stateDir, configPath, workspaceDir, installRoot },
    route: {
      runner: "embedded" as const,
      provider: "fixture",
      model: "repair",
      modelLabel: "fixture/repair",
      agentId: "diagnostic",
      agentDir: state.statePath("agents", "diagnostic", "agent"),
      runConfig: config,
      sourceConfig: config,
    },
  };
}

const completed = (text: string) => ({ payloads: [{ text }], meta: { durationMs: 1 } });

function installationSelectors() {
  const { OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH, OPENCLAW_WORKSPACE_DIR } = process.env;
  return { OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH, OPENCLAW_WORKSPACE_DIR };
}

type ChildTarget = ReturnType<typeof resolveInstallationTarget> & {
  configExists: boolean;
  marker?: string;
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

async function inspectInstallation(
  state: OpenClawTestState,
  layout: "home" | "split",
  fails: boolean,
  workspaceSelector: string,
) {
  vi.spyOn(process, "cwd").mockReturnValue(state.workspaceDir);
  const executionRoot = state.workspaceDir;
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
  const inspectTurn = async () => {
    const config = agentConfig(
      { model: "fixture/diagnostic-model", runtime: { type: "acp" } },
      { agents: { ownership: "explicit" } },
    );
    config.meta = { lastTouchedVersion: marker };
    config.env = { shellEnv: { enabled: false } };
    config.plugins = { enabled: false };
    config.gateway = { auth: { mode: "token", token: secret } };
    await state.writeConfig(config);

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
    const target = resolveInstallationTarget();
    const observedTargets: Record<string, ReturnType<typeof getInstallationTarget>> = {};
    const runtime = createTriageRuntime();
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
    const originalSelectors = installationSelectors();

    let runStateDir = "";
    let shellLookup = "";
    let childTarget: ChildTarget | undefined;
    const runFailure = new Error("synthetic run failure");
    mocks.agentCommand.mockImplementation(async (opts) => {
      const runConfig = getRuntimeConfig();
      observedTargets.repair = getInstallationTarget();
      const prompt = opts.message;
      const archiveReference = /^Sanitized ZIP: (.+)$/mu.exec(prompt)?.[1];
      expect(archiveReference).toBe("$OPENCLAW_STATE_DIR/logs/support/installation.zip");
      expect(prompt).not.toContain(secret);
      expect(prompt).not.toContain(state.stateDir);
      expect(prompt).not.toContain(defaultWorkspaceDir);
      expect(Buffer.byteLength(prompt)).toBeLessThanOrEqual(8 * 1024);
      runStateDir = await fs.realpath(resolveStateDir());

      expect(runStateDir).not.toBe(state.stateDir);
      expect(process.env.OPENCLAW_WORKSPACE_DIR).toBe(executionRoot);

      expect(runConfig.agents?.entries?.diagnostic?.workspace).toBe(executionRoot);
      expect(runConfig.agents?.entries?.diagnostic?.model).toBe("fixture/diagnostic-model");

      const sessionStore = resolveSessionStorePathCore(runConfig.session?.store, {
        agentId: String(opts.agentId),
      });
      expect(sessionStore).toBe(
        path.join(runStateDir, "agents", "diagnostic", "sessions", "sessions.json"),
      );

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

      if (fails) {
        throw runFailure;
      }
      return completed("Synthetic boundary probes completed.");
    });

    expect(getRuntimeConfigSnapshot()).toBeNull();
    const run = withInstallationTarget(target, () =>
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
    expect(await run).toMatchObject({ exitCode: fails ? 1 : 0 });

    expect(runtime.error.mock.calls).toEqual(fails ? [["synthetic run failure"]] : []);
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(getInstallationTarget()).toBeUndefined();
    expect(observedTargets).toEqual({ repair: target });

    expect(mocks.agentCommand).toHaveBeenCalledOnce();

    expect(installationSelectors()).toEqual(originalSelectors);

    expect(getRuntimeConfigSnapshot()).toBeNull();
    await expect(fs.stat(runStateDir)).rejects.toMatchObject({ code: "ENOENT" });

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
      .soft(childTarget, "child OpenClaw must select the original config and default workspace")
      .toEqual(before);
  };
  try {
    await withTriageTerminal(true, inspectTurn);
  } finally {
    vi.restoreAllMocks();
  }
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
        const config = agentConfig({
          model: "fixture/repair@preferred",
          tools: { exec: { mode: "ask", safeBins: ["sed"] }, deny: ["browser"] },
        });
        config.auth = { order: { fixture: ["preferred", "backup"] } };
        config.tools = {
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
        };
        const candidateRoot = state.path("candidate");
        await fs.mkdir(candidateRoot);
        const root = candidate ? candidateRoot : state.workspaceDir;
        const { target, route } = repairFixture(state, config, root);
        const { agentDir } = route;
        const selection = {
          provider: "fixture",
          model: "repair",
          agentDir,
          userLockedAuthProfileId: "preferred",
          fallbacksOverride: ["fixture/fallback"],
        };
        mocks.runEmbeddedAgentEntry.mockImplementation(
          async (params: {
            selection: typeof selection;
            runCandidate: (
              provider: string,
              model: string,
              options: { agentHarnessRuntimeOverride: string },
            ) => Promise<unknown>;
          }) => {
            expect(params.selection).toMatchObject(selection);
            const { provider, model } = params.selection;
            const result = await params.runCandidate(provider, model, {
              agentHarnessRuntimeOverride: "openclaw",
            });
            return { result, provider, model, terminal: { outcome: { status: "ok" } } };
          },
        );
        mocks.runEmbeddedAgent.mockImplementation(async (opts: RunEmbeddedAgentParams) => {
          const runConfig = opts.config!;
          const tools = runConfig.tools;
          const diagnostic = runConfig.agents?.entries?.diagnostic;
          expect(opts).toMatchObject({
            workspaceDir: root,
            cwd: root,
            agentDir,
            authProfileId: "preferred",
            authProfileIdSource: "user",
            sessionPersistence: "detached",
          });
          expect(opts.modelFallbacksOverride).toEqual(["fixture/fallback"]);
          expect(getInstallationTarget()).toEqual({
            stateDir: state.stateDir,
            configPath: state.configPath,
            defaultWorkspaceDir: state.workspaceDir,
          });
          expect(diagnostic?.workspace).toBe(root);
          expect(tools?.fs?.workspaceOnly).toBe(true);
          expect(diagnostic?.tools?.fs?.workspaceOnly).toBe(true);
          expect(tools?.exec).toMatchObject({ mode: "full", safeBins: ["cat"] });
          expect(diagnostic?.tools?.exec).toMatchObject({ mode: "full", safeBins: ["sed"] });
          expect(tools?.allow).toEqual(["exec", "process", "read", "write", "edit", "apply_patch"]);
          expect(tools?.alsoAllow).toEqual(tools?.allow);
          expect(tools?.deny).toEqual(["browser"]);
          expect(diagnostic?.tools?.deny).toEqual(["browser"]);
          expect(tools?.byProvider).toEqual(config.tools?.byProvider);
          expect(resolveExecToolConfig({ cfg: runConfig, agentId: "diagnostic" })).toMatchObject({
            mode: "full",
            security: "full",
            ask: "off",
            safeBins: ["sed"],
          });
          expect(runConfig.auth).toEqual(config.auth);
          expect(diagnostic?.model).toBe("fixture/repair@preferred");
          return completed("Fixture completed.");
        });
        const result = await runUpdateRepairTurn({
          target,
          route: { ...route, authProfileId: "preferred" },
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
        expect(result.envelope).toMatchObject({ status: "ok" });
        expect(result.envelope.error).toBeUndefined();
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
      const config = agentConfig({ tools: agentTools }, { tools });
      const { target, route } = repairFixture(state, config);
      vi.spyOn(repairRuntime, "prepareUpdateRepairInference").mockResolvedValue({
        ok: true,
        route,
        modelFallbacks: [],
      });
      mocks.runEmbeddedAgent.mockResolvedValue(completed("Should not run"));
      const result = await runUpdateRepairLoop({
        target,
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
      const config = agentConfig(agent, { agents: { ownership: "explicit" } });
      setRuntimeConfigSnapshot(config);
      const runAgent = mocks.agentCommand
        .mockReset()
        .mockResolvedValue(completed("fixture completed"));
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const target = resolveInstallationTarget();
      const result = await withInstallationTarget(target, () =>
        agentExec.agentExecCommand("inspect", { cwd: state.workspaceDir }, runtime),
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
      );
      expect(ordinary.exitCode).toBe(0);
      expect(runAgent).toHaveBeenCalledOnce();
    });
  });
  it.each([
    ["split", false, "custom"],
    ["home", false, "default"],
    ["split", true, "default"],
  ] as const)(
    "keeps the %s installation addressable (fails=%s, workspace=%s)",
    async (layout, fails, workspaceSelector) => {
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
      });
      try {
        await withEnvAsync(syntheticEnv, () =>
          withOpenClawTestState(
            {
              layout,
              label: "triage-target",
              ...(layout === "home"
                ? { env: { OPENCLAW_STATE_DIR: undefined, OPENCLAW_CONFIG_PATH: undefined } }
                : {}),
            },
            (state) => inspectInstallation(state, layout, fails, workspaceSelector),
          ),
        );
      } finally {
        if (previousSnapshot) {
          setRuntimeConfigSnapshot(previousSnapshot);
        }
        pinRuntimePaths();
      }
    },
  );
});
