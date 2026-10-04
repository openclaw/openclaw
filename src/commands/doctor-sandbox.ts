import fs from "node:fs";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentEntriesWithSource } from "../agents/agent-scope-config.js";
import {
  DEFAULT_SANDBOX_BROWSER_IMAGE,
  DEFAULT_SANDBOX_COMMON_IMAGE,
  DEFAULT_SANDBOX_IMAGE,
  isDockerDaemonUnavailable,
  resolveSandboxScope,
} from "../agents/sandbox.js";
import {
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_BROWSERS_DIR,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_REGISTRY_PATH,
} from "../agents/sandbox/constants.js";
import {
  DOCKER_SANDBOX_ENGINE,
  PODMAN_SANDBOX_ENGINE,
  validateSandboxContainerEngineTarget,
} from "../agents/sandbox/docker.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveOpenClawPackageRootsSync } from "../infra/openclaw-root.js";
import {
  assertNoRetiredStateFiles,
  createRetiredStateInspectionError,
} from "../infra/state-migrations.retired-files.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const SANDBOX_REGISTRY_FILES_CHECK_ID = "core/doctor/sandbox/registry-files";

type SandboxScriptInfo = {
  scriptPath: string;
  cwd: string;
};

function resolveSandboxScript(scriptRel: string): SandboxScriptInfo | null {
  // Scan every openclaw package root the shared resolver finds (symlinked launcher via realpath,
  // then cwd) and return the first that actually holds the script. The resolver follows npm/pnpm
  // global bins and version-manager links, but a published package root can resolve first and ship
  // without scripts/sandbox-setup.sh (the npm files allowlist drops scripts/); stopping at the
  // first root would then skip a valid source-checkout cwd that still has it.
  const roots = resolveOpenClawPackageRootsSync({
    cwd: process.cwd(),
    argv1: process.argv[1],
  });
  for (const root of roots) {
    const scriptPath = path.join(root, scriptRel);
    if (fs.existsSync(scriptPath)) {
      return { scriptPath, cwd: root };
    }
  }
  return null;
}

async function runSandboxScript(scriptRel: string, runtime: RuntimeEnv): Promise<void> {
  const script = resolveSandboxScript(scriptRel);
  if (!script) {
    note(`Unable to locate ${scriptRel}. Run it from the repo root.`, "Sandbox");
    return;
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
    return;
  }

  runtime.log(`Completed ${scriptRel}.`);
}

async function isContainerEngineAvailable(command: "docker" | "podman"): Promise<boolean> {
  try {
    await runExec(
      command,
      command === "docker" ? ["version", "--format", "{{.Server.Version}}"] : ["info"],
      {
        timeoutMs: 5_000,
      },
    );
    return true;
  } catch {
    return false;
  }
}

type CodexBwrapNamespaceProbe =
  | { ok: true }
  | { ok: false; kind: "user" | "network"; command: string; reason: string }
  | { ok: false; kind: "unverified"; command?: string; reason: string };

type SandboxHealthOptions = { env?: NodeJS.ProcessEnv; cwd?: string };

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

async function probeCodexBwrapNamespaces(
  cfg: OpenClawConfig,
  options: SandboxHealthOptions,
): Promise<CodexBwrapNamespaceProbe> {
  const userProbe = await runCodexBwrapNamespaceProbe("user", [
    "--user",
    "--map-root-user",
    "true",
  ]);
  if (!userProbe.ok || !codexBwrapNeedsNetworkNamespaceProbe(cfg)) {
    return userProbe;
  }
  try {
    const { resolveCodexHealthApi } = await import("../flows/bundled-health-checks.js");
    const selected = resolveCodexHealthApi({ cfg, ...options });
    if (selected.status === "not-configured") {
      return { ok: true };
    }
    if (selected.status === "unavailable") {
      return { ok: false, kind: "unverified", reason: selected.reason };
    }
    if (typeof selected.api.probeCodexWorkspaceWriteSandbox !== "function") {
      return {
        ok: false,
        kind: "unverified",
        reason: "The selected Codex plugin does not provide a workspace-write sandbox check.",
      };
    }
    const probe = await selected.api.probeCodexWorkspaceWriteSandbox({ cfg, env: options.env });
    if (probe.status === "ok" || probe.status === "skipped") {
      return { ok: true };
    }
    if (probe.status === "inconclusive") {
      return {
        ok: false,
        kind: "unverified",
        ...(probe.command ? { command: probe.command } : {}),
        reason: probe.reason,
      };
    }
    // Codex's bwrap can still fail uid mapping or namespace creation after `unshare` succeeds.
    const kind = probe.denial.startsWith("bwrap: loopback:") ? "network" : "user";
    return { ok: false, kind, command: probe.command, reason: probe.denial };
  } catch (error) {
    return {
      ok: false,
      kind: "unverified",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Resolves the enabled sandbox backend and its local container engine, when it has one. */
function resolveEnabledSandboxBackend(cfg: OpenClawConfig) {
  const sandbox = cfg.agents?.defaults?.sandbox;
  const mode = sandbox?.mode ?? "off";
  if (!sandbox || mode === "off") {
    return undefined;
  }
  const backend = (sandbox.backend?.trim() || "docker").toLowerCase();
  const containerEngine =
    backend === "podman"
      ? PODMAN_SANDBOX_ENGINE
      : backend === "docker"
        ? DOCKER_SANDBOX_ENGINE
        : undefined;
  return { sandbox, mode, backend, containerEngine };
}

export async function noteCodexBwrapNamespaceWarnings(
  cfg: OpenClawConfig,
  options: SandboxHealthOptions = {},
): Promise<void> {
  const containerEngine = resolveEnabledSandboxBackend(cfg)?.containerEngine;
  if (process.platform !== "linux" || !containerEngine) {
    return;
  }
  if (!(await isContainerEngineAvailable(containerEngine.command))) {
    return;
  }
  const engineName = containerEngine.displayName;
  const probe = await probeCodexBwrapNamespaces(cfg, options);
  if (probe.ok) {
    return;
  }
  if (probe.kind === "unverified") {
    note(
      [
        "Doctor could not verify the Codex bwrap network sandbox.",
        ...(probe.command ? [`Check command: ${probe.command}`] : []),
        `Check result: ${probe.reason}`,
        `Resolve the check result above, then rerun ${formatCliCommand("openclaw doctor")} to check Codex's host namespace policy.`,
      ].join("\n"),
      "Sandbox",
    );
    return;
  }
  const symptom =
    probe.kind === "user"
      ? "  bwrap: setting up uid map: Permission denied"
      : "  bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted";
  const networkSentence = codexBwrapNeedsNetworkNamespaceProbe(cfg)
    ? `With ${engineName} sandbox network egress disabled, it also needs an unprivileged network namespace.`
    : `${engineName} sandbox network egress is enabled, so doctor only checked the user namespace.`;
  const lines = [
    `Codex bwrap ${probe.kind} namespace check failed while ${engineName} sandbox mode is enabled.`,
    `Codex app-server \`workspace-write\` shell execution needs unprivileged user namespaces. ${networkSentence}`,
    "On Ubuntu/AppArmor hosts this usually appears as:",
    symptom,
    `Check command: ${probe.command}`,
    `Check result: ${probe.reason}`,
    "",
    "Fix the host namespace policy for the OpenClaw service user, then restart the gateway.",
    "Prefer an AppArmor profile that grants the required namespaces to the OpenClaw service process.",
    "`kernel.apparmor_restrict_unprivileged_userns=0` is a host-wide fallback with security tradeoffs; use it only when that host posture is acceptable.",
    "Do not add broad Docker container privileges just to satisfy nested bwrap; that weakens the outer sandbox.",
  ];
  note(lines.join("\n"), "Sandbox");
}

async function containerImageExists(command: "docker" | "podman", image: string): Promise<boolean> {
  try {
    await runExec(command, ["image", "inspect", image], { timeoutMs: 5_000 });
    return true;
  } catch (error) {
    const stderr =
      (error as { stderr: string } | undefined)?.stderr ||
      (error as { message: string } | undefined)?.message ||
      "";
    const imageMissing =
      command === "docker"
        ? stderr.includes("No such image")
        : /No such image|image not known|image .* not found/iu.test(stderr);
    if (imageMissing) {
      return false;
    }
    if (command === "docker" && isDockerDaemonUnavailable(stderr)) {
      return false;
    }
    throw error;
  }
}

type SandboxImageCheck = {
  engineCommand: "docker" | "podman";
  kind: string;
  image: string;
  buildScript?: string;
};

async function handleMissingSandboxImage(
  params: SandboxImageCheck,
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  const exists = await containerImageExists(params.engineCommand, params.image);
  if (exists) {
    return;
  }

  const buildHint = params.buildScript
    ? `Build it with ${params.buildScript}.`
    : "Build or pull it first.";
  note(`Sandbox ${params.kind} image missing: ${params.image}. ${buildHint}`, "Sandbox");

  if (params.buildScript) {
    const build = await prompter.confirmRuntimeRepair({
      message: `Build ${params.kind} sandbox image now?`,
      initialValue: true,
    });
    if (build) {
      await runSandboxScript(params.buildScript, runtime);
    }
  }
}

/**
 * Checks configured sandbox images and optionally runs repo build scripts for missing defaults.
 *
 * Non-container backends skip image checks.
 */
export async function maybeRepairSandboxImages(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
): Promise<OpenClawConfig> {
  const enabled = resolveEnabledSandboxBackend(cfg);
  if (!enabled) {
    return cfg;
  }
  const { sandbox, mode, backend, containerEngine } = enabled;
  if (!containerEngine) {
    if (sandbox.browser?.enabled) {
      note(
        `Sandbox backend "${backend}" selected. Docker browser health checks are skipped; browser sandbox currently requires the docker backend.`,
        "Sandbox",
      );
    }
    return cfg;
  }

  const engineAvailable = await isContainerEngineAvailable(containerEngine.command);
  if (!engineAvailable) {
    const name = containerEngine.displayName;
    const lines = [
      `Sandbox mode is enabled (mode: "${mode}") but ${name} is not available.`,
      containerEngine.id === "docker"
        ? "Docker is required for sandbox mode to function."
        : "Podman is required by the selected sandbox backend.",
      `Isolated sessions (automations, sub-agents) will fail without ${name}.`,
      "",
      "Options:",
      `- Install ${name} and restart the gateway`,
      "- Disable sandbox mode: openclaw config set agents.defaults.sandbox.mode off",
    ];
    note(lines.join("\n"), "Sandbox");
    return cfg;
  }
  await validateSandboxContainerEngineTarget(containerEngine);

  const dockerImage = sandbox.docker?.image?.trim() || DEFAULT_SANDBOX_IMAGE;
  await handleMissingSandboxImage(
    {
      engineCommand: containerEngine.command,
      kind: "base",
      image: dockerImage,
      buildScript:
        containerEngine.id !== "docker"
          ? undefined
          : dockerImage === DEFAULT_SANDBOX_COMMON_IMAGE
            ? "scripts/sandbox-common-setup.sh"
            : dockerImage === DEFAULT_SANDBOX_IMAGE
              ? "scripts/sandbox-setup.sh"
              : undefined,
    },
    runtime,
    prompter,
  );

  if (sandbox.browser?.enabled && containerEngine.id === "docker") {
    await handleMissingSandboxImage(
      {
        engineCommand: containerEngine.command,
        kind: "browser",
        image: sandbox.browser.image?.trim() || DEFAULT_SANDBOX_BROWSER_IMAGE,
        buildScript: "scripts/sandbox-browser-setup.sh",
      },
      runtime,
      prompter,
    );
  } else if (sandbox.browser?.enabled) {
    note(
      "Podman sandbox selected. Browser sandbox health checks are skipped because browser sandboxing requires the Docker engine.",
      "Sandbox",
    );
  }

  return cfg;
}

type LegacySandboxRegistryInspection = {
  kind: "containers" | "browsers";
  path: string;
  source: "monolithic" | "sharded";
};

function formatLegacyRegistryInspectionLine(file: LegacySandboxRegistryInspection): string {
  return `- ${file.kind} ${file.source}: ${shortenHomePath(file.path)} (retired)`;
}

function legacySandboxRegistryUpgradeHint(): string {
  return `Upgrade through OpenClaw 2026.9.7 and run ${formatCliCommand("openclaw doctor --fix")} on the original host before retrying. The retired files are left unchanged.`;
}

export async function detectLegacySandboxRegistryFileIssues(): Promise<
  readonly LegacySandboxRegistryInspection[]
> {
  const targets: LegacySandboxRegistryInspection[] = [
    { kind: "containers", path: SANDBOX_REGISTRY_PATH, source: "monolithic" },
    { kind: "containers", path: SANDBOX_CONTAINERS_DIR, source: "sharded" },
    { kind: "browsers", path: SANDBOX_BROWSER_REGISTRY_PATH, source: "monolithic" },
    { kind: "browsers", path: SANDBOX_BROWSERS_DIR, source: "sharded" },
  ];
  return targets.filter((target) => {
    try {
      // Even broken links retain operator state; inspect names without opening retired contents.
      fs.lstatSync(target.path);
      return true;
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return false;
      }
      throw createRetiredStateInspectionError(target.path, error);
    }
  });
}

export function legacySandboxRegistryInspectionToHealthFinding(
  file: LegacySandboxRegistryInspection,
): HealthFinding {
  return {
    checkId: SANDBOX_REGISTRY_FILES_CHECK_ID,
    severity: "warning",
    message: `Retired sandbox registry file detected.
${formatLegacyRegistryInspectionLine(file)}`,
    path: file.path,
    fixHint: legacySandboxRegistryUpgradeHint(),
  };
}

export function legacySandboxRegistryInspectionToRepairEffect(
  file: LegacySandboxRegistryInspection,
): HealthRepairEffect {
  return {
    kind: "state",
    action: "requires-intermediate-sandbox-registry-upgrade",
    target: file.path,
    dryRunSafe: false,
  };
}

export async function maybeRepairSandboxRegistryFiles(
  prompter: Pick<DoctorPrompter, "shouldRepair">,
): Promise<void> {
  const legacyFiles = await detectLegacySandboxRegistryFileIssues();
  if (legacyFiles.length === 0) {
    return;
  }
  if (prompter.shouldRepair) {
    assertNoRetiredStateFiles(
      "Sandbox registries",
      legacyFiles.map((file) => file.path),
    );
    return;
  }
  note(
    [
      "Retired sandbox registry files detected.",
      ...legacyFiles.map(formatLegacyRegistryInspectionLine),
      legacySandboxRegistryUpgradeHint(),
    ].join("\n"),
    "Sandbox",
  );
}

export function noteSandboxScopeWarnings(cfg: OpenClawConfig) {
  const globalSandbox = cfg.agents?.defaults?.sandbox;
  const warnings: string[] = [];

  for (const { entry: agent, source } of listAgentEntriesWithSource(cfg)) {
    const agentId = agent.id;
    const agentSandbox = agent.sandbox;
    if (!agentSandbox) {
      continue;
    }

    const scope = resolveSandboxScope({
      scope: agentSandbox.scope ?? globalSandbox?.scope,
    });

    if (scope !== "shared") {
      continue;
    }

    const overrides = (["docker", "browser", "prune"] as const).filter(
      (key) => agentSandbox[key] && Object.keys(agentSandbox[key]).length > 0,
    );

    if (overrides.length === 0) {
      continue;
    }

    const agentPath =
      source.kind === "entries" ? `agents.entries.${source.key}` : `agents.list (id "${agentId}")`;
    warnings.push(
      [
        `- ${agentPath} sandbox ${overrides.join("/")} overrides ignored.`,
        `  scope resolves to "shared".`,
      ].join("\n"),
    );
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Sandbox");
  }
}
