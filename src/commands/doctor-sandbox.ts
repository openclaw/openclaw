import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_COMMON_IMAGE,
  DEFAULT_SANDBOX_IMAGE,
  isDockerDaemonUnavailable,
  resolveSandboxScope,
} from "../agents/sandbox.js";
import {
  inspectLegacySandboxRegistryFiles,
  migrateLegacySandboxRegistryFiles,
  type LegacySandboxRegistryInspection,
  type LegacySandboxRegistryMigrationResult,
} from "../agents/sandbox/registry.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type SandboxScriptInfo = {
  scriptPath: string;
  cwd: string;
};

function resolveSandboxScript(scriptRel: string): SandboxScriptInfo | null {
  const candidates = new Set<string>();
  candidates.add(process.cwd());
  const argv1 = process.argv[1];
  if (argv1) {
    const normalized = path.resolve(argv1);
    candidates.add(path.resolve(path.dirname(normalized), ".."));
    candidates.add(path.resolve(path.dirname(normalized)));
  }

  for (const root of candidates) {
    const scriptPath = path.join(root, scriptRel);
    if (fs.existsSync(scriptPath)) {
      return { scriptPath, cwd: root };
    }
  }

  return null;
}

async function runSandboxScript(scriptRel: string, runtime: RuntimeEnv): Promise<boolean> {
  const script = resolveSandboxScript(scriptRel);
  if (!script) {
    note(`Unable to locate ${scriptRel}. Run it from the repo root.`, "Sandbox");
    return false;
  }

  runtime.log(`Running ${scriptRel}...`);
  const result = await runCommandWithTimeout(["bash", script.scriptPath], {
    timeoutMs: 20 * 60 * 1000,
    cwd: script.cwd,
  });
  if (result.code !== 0) {
    runtime.error(
      `Failed running ${scriptRel}: ${
        result.stderr.trim() || result.stdout.trim() || "unknown error"
      }`,
    );
    return false;
  }

  runtime.log(`Completed ${scriptRel}.`);
  return true;
}

async function isDockerAvailable(): Promise<boolean> {
  try {
    await runExec("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeoutMs: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

type CodexBwrapNamespaceProbe =
  | { ok: true }
  | { ok: false; kind: "user" | "network"; command: string; reason: string };

function formatNamespaceProbeCommand(args: string[]): string {
  return ["unshare", ...args].join(" ");
}

async function runCodexBwrapNamespaceProbe(
  kind: "user" | "network",
  args: string[],
): Promise<CodexBwrapNamespaceProbe> {
  try {
    await runExec("unshare", args, {
      timeoutMs: 5_000,
    });
    return { ok: true };
  } catch (error) {
    const reason =
      (error as { stderr?: string } | undefined)?.stderr?.trim() ||
      (error as { stdout?: string } | undefined)?.stdout?.trim() ||
      (error instanceof Error ? error.message : String(error));
    return { ok: false, kind, command: formatNamespaceProbeCommand(args), reason };
  }
}

function codexBwrapNeedsNetworkNamespaceProbe(cfg: OpenClawConfig): boolean {
  const network = cfg.agents?.defaults?.sandbox?.docker?.network?.trim().toLowerCase();
  return network === undefined || network === "" || network === "none";
}

async function probeCodexBwrapNamespaces(cfg: OpenClawConfig): Promise<CodexBwrapNamespaceProbe> {
  if (process.platform !== "linux") {
    return { ok: true };
  }
  const userProbe = await runCodexBwrapNamespaceProbe("user", [
    "--user",
    "--map-root-user",
    "true",
  ]);
  if (!userProbe.ok || !codexBwrapNeedsNetworkNamespaceProbe(cfg)) {
    return userProbe;
  }
  return await runCodexBwrapNamespaceProbe("network", [
    "--user",
    "--map-root-user",
    "--net",
    "true",
  ]);
}

function formatCodexBwrapNamespaceWarning(
  cfg: OpenClawConfig,
  probe: Exclude<CodexBwrapNamespaceProbe, { ok: true }>,
): string {
  const symptom =
    probe.kind === "user"
      ? "  bwrap: setting up uid map: Permission denied"
      : "  bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";
  const networkSentence = codexBwrapNeedsNetworkNamespaceProbe(cfg)
    ? "With Docker sandbox network egress disabled, it also needs an unprivileged network namespace."
    : "Docker sandbox network egress is enabled, so doctor only checked the user namespace.";
  const lines = [
    `Codex bwrap ${probe.kind} namespace probe failed while Docker sandbox mode is enabled.`,
    `Codex app-server \`workspace-write\` shell execution needs unprivileged user namespaces. ${networkSentence}`,
    "On Ubuntu/AppArmor hosts this usually appears as:",
    symptom,
    `Probe command: ${probe.command}`,
    `Probe result: ${probe.reason}`,
    "",
    "Fix the host namespace policy for the OpenClaw service user, then restart the gateway.",
    "Prefer an AppArmor profile that grants the required namespaces to the OpenClaw service process.",
    "`kernel.apparmor_restrict_unprivileged_userns=0` is a host-wide fallback with security tradeoffs; use it only when that host posture is acceptable.",
    "Do not add broad Docker container privileges just to satisfy nested bwrap; that weakens the outer sandbox.",
  ];
  return lines.join("\n");
}

async function detectCodexBwrapNamespaceIssue(
  cfg: OpenClawConfig,
): Promise<SandboxImageIssue | null> {
  const probe = await probeCodexBwrapNamespaces(cfg);
  if (probe.ok) {
    return null;
  }
  return {
    kind: "codex-bwrap-namespace-unavailable",
    namespaceKind: probe.kind,
    path: "agents.defaults.sandbox.mode",
    message: `Codex bwrap ${probe.kind} namespace probe failed while Docker sandbox mode is enabled.`,
    fixHint: formatCodexBwrapNamespaceWarning(cfg, probe),
  };
}

async function noteCodexBwrapNamespaceWarning(cfg: OpenClawConfig): Promise<void> {
  const issue = await detectCodexBwrapNamespaceIssue(cfg);
  if (!issue) {
    return;
  }
  note(issue.fixHint, "Sandbox");
}

async function dockerImageExists(image: string): Promise<boolean> {
  try {
    await runExec("docker", ["image", "inspect", image], { timeoutMs: 5_000 });
    return true;
  } catch (error) {
    const stderr =
      (error as { stderr: string } | undefined)?.stderr ||
      (error as { message: string } | undefined)?.message ||
      "";
    if (stderr.includes("No such image")) {
      return false;
    }
    if (isDockerDaemonUnavailable(stderr)) {
      return false;
    }
    throw error;
  }
}

function resolveSandboxDockerImage(cfg: OpenClawConfig): string {
  const image = cfg.agents?.defaults?.sandbox?.docker?.image?.trim();
  return image ? image : DEFAULT_SANDBOX_IMAGE;
}

function resolveSandboxBackend(cfg: OpenClawConfig): string {
  const backend = cfg.agents?.defaults?.sandbox?.backend?.trim();
  return backend || "docker";
}

function resolveSandboxBrowserImage(cfg: OpenClawConfig): string {
  const image = cfg.agents?.defaults?.sandbox?.browser?.image?.trim();
  return image ? image : DEFAULT_SANDBOX_BROWSER_IMAGE;
}

function updateSandboxDockerImage(cfg: OpenClawConfig, image: string): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        sandbox: {
          ...cfg.agents?.defaults?.sandbox,
          docker: {
            ...cfg.agents?.defaults?.sandbox?.docker,
            image,
          },
        },
      },
    },
  };
}

function updateSandboxBrowserImage(cfg: OpenClawConfig, image: string): OpenClawConfig {
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        sandbox: {
          ...cfg.agents?.defaults?.sandbox,
          browser: {
            ...cfg.agents?.defaults?.sandbox?.browser,
            image,
          },
        },
      },
    },
  };
}

type SandboxImageCheck = {
  kind: string;
  image: string;
  buildScript?: string;
  updateConfig: (image: string) => void;
};

export type SandboxRegistryFileIssue = LegacySandboxRegistryInspection & {
  exists: true;
};

export type SandboxImageIssue =
  | {
      kind: "docker-unavailable";
      mode: string;
      path: string;
      message: string;
      fixHint: string;
    }
  | {
      kind: "browser-backend-unsupported";
      backend: string;
      path: string;
      message: string;
      fixHint: string;
    }
  | {
      kind: "missing-image";
      imageKind: "base" | "browser";
      image: string;
      path: string;
      buildScript?: string;
      message: string;
      fixHint: string;
    }
  | {
      kind: "codex-bwrap-namespace-unavailable";
      namespaceKind: "user" | "network";
      path: string;
      message: string;
      fixHint: string;
    };

export type SandboxScopeWarning = {
  agentId: string | undefined;
  overrides: readonly string[];
  path: string;
  message: string;
  fixHint: string;
};

export type SandboxImageRepairResult = {
  status?: "repaired" | "skipped" | "failed";
  reason?: string;
  config: OpenClawConfig;
  changes: string[];
  warnings: string[];
};

type SandboxImageRepairPrompter = Pick<DoctorPrompter, "confirmRuntimeRepair"> & {
  note?: (message: string, title: string) => void | Promise<void>;
};

type SandboxImageBuildResult = "built" | "skipped" | "failed";

async function emitSandboxRepairNote(
  prompter: Pick<SandboxImageRepairPrompter, "note">,
  message: string,
  title: string,
): Promise<void> {
  if (prompter.note) {
    await prompter.note(message, title);
    return;
  }
  note(message, title);
}

async function handleMissingSandboxImage(
  params: SandboxImageCheck,
  runtime: RuntimeEnv,
  prompter: SandboxImageRepairPrompter,
): Promise<SandboxImageBuildResult> {
  const exists = await dockerImageExists(params.image);
  if (exists) {
    return "skipped";
  }

  const buildHint = params.buildScript
    ? `Build it with ${params.buildScript}.`
    : "Build or pull it first.";
  const message = `Sandbox ${params.kind} image missing: ${params.image}. ${buildHint}`;
  await emitSandboxRepairNote(prompter, message, "Sandbox");

  if (params.buildScript) {
    const build = await prompter.confirmRuntimeRepair({
      message: `Build ${params.kind} sandbox image now?`,
      initialValue: true,
    });
    if (build) {
      return (await runSandboxScript(params.buildScript, runtime)) ? "built" : "failed";
    }
  }

  return "skipped";
}

export async function detectSandboxRegistryFileIssues(): Promise<
  readonly SandboxRegistryFileIssue[]
> {
  return (await inspectLegacySandboxRegistryFiles()).filter(
    (file): file is SandboxRegistryFileIssue => file.exists,
  );
}

function buildSandboxImageIssue(params: {
  imageKind: "base" | "browser";
  image: string;
  path: string;
  buildScript?: string;
}): SandboxImageIssue {
  const buildHint = params.buildScript
    ? `Build it with ${params.buildScript}.`
    : "Build or pull it first.";
  return {
    kind: "missing-image",
    imageKind: params.imageKind,
    image: params.image,
    path: params.path,
    buildScript: params.buildScript,
    message: `Sandbox ${params.imageKind} image missing: ${params.image}.`,
    fixHint: buildHint,
  };
}

function sandboxImageIssueWarning(issue: { message: string; fixHint?: string }): string {
  return issue.fixHint ? `${issue.message} ${issue.fixHint}` : issue.message;
}

export async function detectSandboxImageIssues(
  cfg: OpenClawConfig,
): Promise<readonly SandboxImageIssue[]> {
  const sandbox = cfg.agents?.defaults?.sandbox;
  const mode = sandbox?.mode ?? "off";
  if (!sandbox || mode === "off") {
    return [];
  }

  const backend = resolveSandboxBackend(cfg);
  if (backend !== "docker") {
    if (sandbox.browser?.enabled) {
      return [
        {
          kind: "browser-backend-unsupported",
          backend,
          path: "agents.defaults.sandbox.backend",
          message: `Sandbox backend "${backend}" selected. Docker browser health checks are skipped; browser sandbox currently requires the docker backend.`,
          fixHint:
            "Use the docker sandbox backend for browser sandboxing or disable sandbox.browser.enabled.",
        },
      ];
    }
    return [];
  }

  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    return [
      {
        kind: "docker-unavailable",
        mode,
        path: "agents.defaults.sandbox.mode",
        message: `Sandbox mode is enabled (mode: "${mode}") but Docker is not available.`,
        fixHint:
          "Install Docker and restart the gateway, or disable sandbox mode with `openclaw config set agents.defaults.sandbox.mode off`.",
      },
    ];
  }

  const issues: SandboxImageIssue[] = [];
  const namespaceIssue = await detectCodexBwrapNamespaceIssue(cfg);
  if (namespaceIssue) {
    issues.push(namespaceIssue);
  }
  const dockerImage = resolveSandboxDockerImage(cfg);
  if (!(await dockerImageExists(dockerImage))) {
    issues.push(
      buildSandboxImageIssue({
        imageKind: "base",
        image: dockerImage,
        path: "agents.defaults.sandbox.docker.image",
        buildScript:
          dockerImage === DEFAULT_SANDBOX_COMMON_IMAGE
            ? "scripts/sandbox-common-setup.sh"
            : dockerImage === DEFAULT_SANDBOX_IMAGE
              ? "scripts/sandbox-setup.sh"
              : undefined,
      }),
    );
  }

  if (sandbox.browser?.enabled) {
    const browserImage = resolveSandboxBrowserImage(cfg);
    if (!(await dockerImageExists(browserImage))) {
      issues.push(
        buildSandboxImageIssue({
          imageKind: "browser",
          image: browserImage,
          path: "agents.defaults.sandbox.browser.image",
          buildScript:
            browserImage === DEFAULT_SANDBOX_BROWSER_IMAGE
              ? "scripts/sandbox-browser-setup.sh"
              : undefined,
        }),
      );
    }
  }

  return issues;
}

export async function maybeRepairSandboxImages(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
): Promise<OpenClawConfig> {
  const sandbox = cfg.agents?.defaults?.sandbox;
  const mode = sandbox?.mode ?? "off";
  if (!sandbox || mode === "off") {
    return cfg;
  }
  const backend = resolveSandboxBackend(cfg);
  if (backend !== "docker") {
    if (sandbox.browser?.enabled) {
      note(
        `Sandbox backend "${backend}" selected. Docker browser health checks are skipped; browser sandbox currently requires the docker backend.`,
        "Sandbox",
      );
    }
    return cfg;
  }

  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    const lines = [
      `Sandbox mode is enabled (mode: "${mode}") but Docker is not available.`,
      "Docker is required for sandbox mode to function.",
      "Isolated sessions (cron jobs, sub-agents) will fail without Docker.",
      "",
      "Options:",
      "- Install Docker and restart the gateway",
      "- Disable sandbox mode: openclaw config set agents.defaults.sandbox.mode off",
    ];
    note(lines.join("\n"), "Sandbox");
    return cfg;
  }
  await noteCodexBwrapNamespaceWarning(cfg);

  let next = cfg;
  const changes: string[] = [];

  const dockerImage = resolveSandboxDockerImage(cfg);
  await handleMissingSandboxImage(
    {
      kind: "base",
      image: dockerImage,
      buildScript:
        dockerImage === DEFAULT_SANDBOX_COMMON_IMAGE
          ? "scripts/sandbox-common-setup.sh"
          : dockerImage === DEFAULT_SANDBOX_IMAGE
            ? "scripts/sandbox-setup.sh"
            : undefined,
      updateConfig: (image) => {
        next = updateSandboxDockerImage(next, image);
        changes.push(`Updated agents.defaults.sandbox.docker.image → ${image}`);
      },
    },
    runtime,
    prompter,
  );

  if (sandbox.browser?.enabled) {
    const browserImage = resolveSandboxBrowserImage(cfg);
    await handleMissingSandboxImage(
      {
        kind: "browser",
        image: browserImage,
        buildScript:
          browserImage === DEFAULT_SANDBOX_BROWSER_IMAGE
            ? "scripts/sandbox-browser-setup.sh"
            : undefined,
        updateConfig: (image) => {
          next = updateSandboxBrowserImage(next, image);
          changes.push(`Updated agents.defaults.sandbox.browser.image → ${image}`);
        },
      },
      runtime,
      prompter,
    );
  }

  if (changes.length > 0) {
    note(changes.join("\n"), "Doctor changes");
  }

  return next;
}

export async function repairSandboxImages(params: {
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  prompter: SandboxImageRepairPrompter;
  issues?: readonly SandboxImageIssue[];
}): Promise<SandboxImageRepairResult> {
  const sandbox = params.cfg.agents?.defaults?.sandbox;
  const mode = sandbox?.mode ?? "off";
  if (!sandbox || mode === "off") {
    return { config: params.cfg, changes: [], warnings: [] };
  }
  const backend = resolveSandboxBackend(params.cfg);
  if (backend !== "docker") {
    if (!sandbox.browser?.enabled) {
      return { config: params.cfg, changes: [], warnings: [] };
    }
    return {
      config: params.cfg,
      changes: [],
      warnings: [
        `Sandbox backend "${backend}" selected. Docker browser health checks are skipped; browser sandbox currently requires the docker backend.`,
      ],
    };
  }

  const dockerAvailable = await isDockerAvailable();
  if (!dockerAvailable) {
    return {
      config: params.cfg,
      changes: [],
      warnings: [
        [
          `Sandbox mode is enabled (mode: "${mode}") but Docker is not available.`,
          "Docker is required for sandbox mode to function.",
          "Isolated sessions (cron jobs, sub-agents) will fail without Docker.",
          "Install Docker and restart the gateway, or disable sandbox mode.",
        ].join(" "),
      ],
    };
  }

  let next = params.cfg;
  const changes: string[] = [];
  const checked: string[] = [];
  const warnings: string[] = [];
  const failures: string[] = [];
  const issues = params.issues ?? (await detectSandboxImageIssues(params.cfg));
  let repaired = 0;

  for (const issue of issues) {
    if (issue.kind !== "missing-image") {
      warnings.push(sandboxImageIssueWarning(issue));
      continue;
    }
    const buildResult = await handleMissingSandboxImage(
      {
        kind: issue.imageKind,
        image: issue.image,
        buildScript: issue.buildScript,
        updateConfig: (image) => {
          if (issue.imageKind === "browser") {
            next = updateSandboxBrowserImage(next, image);
            changes.push(`Updated agents.defaults.sandbox.browser.image → ${image}`);
            return;
          }
          next = updateSandboxDockerImage(next, image);
          changes.push(`Updated agents.defaults.sandbox.docker.image → ${image}`);
        },
      },
      params.runtime,
      params.prompter,
    );
    if (buildResult === "built") {
      repaired++;
      checked.push(`Checked sandbox ${issue.imageKind} image ${issue.image}.`);
    } else if (buildResult === "failed") {
      failures.push(`Failed to build sandbox ${issue.imageKind} image ${issue.image}.`);
    }
  }

  if (failures.length > 0) {
    return {
      status: "failed",
      reason: "sandbox image repair failed to build an image",
      config: next,
      changes: [...changes, ...checked],
      warnings: [...warnings, ...failures],
    };
  }

  if (repaired === 0 && changes.length === 0) {
    return {
      status: "skipped",
      reason: "sandbox image repair did not build an image",
      config: next,
      changes: [],
      warnings,
    };
  }

  return {
    config: next,
    changes: [...changes, ...checked],
    warnings,
  };
}

function formatLegacyRegistryInspectionLine(file: LegacySandboxRegistryInspection): string {
  const status = file.valid ? `${file.entries} entr${file.entries === 1 ? "y" : "ies"}` : "invalid";
  return `- ${file.kind}: ${shortenHomePath(file.registryPath)} (${status})`;
}

export function formatLegacySandboxRegistryMigrationLine(
  result: LegacySandboxRegistryMigrationResult,
): string {
  const file = shortenHomePath(result.registryPath);
  if (result.status === "migrated") {
    return `- Migrated ${result.kind} registry from ${file} into ${result.entries} shard${result.entries === 1 ? "" : "s"}.`;
  }
  if (result.status === "removed-empty") {
    return `- Removed empty legacy ${result.kind} registry ${file}.`;
  }
  if (result.status === "quarantined-invalid") {
    const quarantine = result.quarantinePath ? ` to ${shortenHomePath(result.quarantinePath)}` : "";
    return `- Quarantined invalid legacy ${result.kind} registry ${file}${quarantine}.`;
  }
  return "";
}

export async function maybeRepairSandboxRegistryFiles(prompter: DoctorPrompter): Promise<void> {
  const legacyFiles = await detectSandboxRegistryFileIssues();
  if (legacyFiles.length === 0) {
    return;
  }

  if (!prompter.shouldRepair) {
    note(
      [
        "Legacy sandbox registry files detected.",
        ...legacyFiles.map(formatLegacyRegistryInspectionLine),
        `Run ${formatCliCommand("openclaw doctor --fix")} to migrate them to sharded registry files.`,
      ].join("\n"),
      "Sandbox",
    );
    return;
  }

  const results = (await migrateLegacySandboxRegistryFiles())
    .filter((result) => result.status !== "missing")
    .map(formatLegacySandboxRegistryMigrationLine)
    .filter((line) => line.length > 0);
  if (results.length > 0) {
    note(results.join("\n"), "Doctor changes");
  }
}

export function collectSandboxScopeWarnings(cfg: OpenClawConfig): readonly SandboxScopeWarning[] {
  const globalSandbox = cfg.agents?.defaults?.sandbox;
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const warnings: SandboxScopeWarning[] = [];

  agents.forEach((agent, index) => {
    const agentId = agent.id;
    const agentSandbox = agent.sandbox;
    if (!agentSandbox) {
      return;
    }

    const scope = resolveSandboxScope({
      scope: agentSandbox.scope ?? globalSandbox?.scope,
    });

    if (scope !== "shared") {
      return;
    }

    const overrides: string[] = [];
    if (agentSandbox.docker && Object.keys(agentSandbox.docker).length > 0) {
      overrides.push("docker");
    }
    if (agentSandbox.browser && Object.keys(agentSandbox.browser).length > 0) {
      overrides.push("browser");
    }
    if (agentSandbox.prune && Object.keys(agentSandbox.prune).length > 0) {
      overrides.push("prune");
    }

    if (overrides.length === 0) {
      return;
    }

    const agentLabel = agentId ? `id "${agentId}"` : `index ${index}`;
    warnings.push({
      agentId,
      overrides,
      path: agentId ? `agents.list.${agentId}.sandbox` : `agents.list.${index}.sandbox`,
      message: `agents.list (${agentLabel}) sandbox ${overrides.join("/")} overrides ignored.`,
      fixHint: 'scope resolves to "shared".',
    });
  });

  return warnings;
}

export function noteSandboxScopeWarnings(cfg: OpenClawConfig) {
  const warnings = collectSandboxScopeWarnings(cfg);

  if (warnings.length > 0) {
    note(
      warnings.map((warning) => `- ${warning.message}\n  ${warning.fixHint}`).join("\n"),
      "Sandbox",
    );
  }
}
