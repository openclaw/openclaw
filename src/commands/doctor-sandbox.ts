import fs from "node:fs";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentEntriesWithSource } from "../agents/agent-scope-config.js";
import { resolveSandboxConfigForAgent, resolveSandboxScope } from "../agents/sandbox/config.js";
import {
  DEFAULT_SANDBOX_COMMON_IMAGE,
  DEFAULT_SANDBOX_IMAGE,
  SANDBOX_BROWSER_REGISTRY_PATH,
  SANDBOX_BROWSERS_DIR,
  SANDBOX_CONTAINERS_DIR,
  SANDBOX_REGISTRY_PATH,
} from "../agents/sandbox/constants.js";
import {
  DOCKER_SANDBOX_ENGINE,
  isDockerDaemonUnavailable,
  PODMAN_SANDBOX_ENGINE,
  validateSandboxContainerEngineTarget,
  type SandboxContainerEngine,
} from "../agents/sandbox/docker.js";
import type { SandboxConfig } from "../agents/sandbox/types.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { hasErrnoCode } from "../infra/errno.js";
import { resolveOpenClawPackageRootsSync } from "../infra/openclaw-root.js";
import { archiveRetiredStateFiles } from "../infra/state-migrations.retired-archive.js";
import { createRetiredStateInspectionError } from "../infra/state-migrations.retired-files.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const SANDBOX_REGISTRY_FILES_CHECK_ID = "core/doctor/sandbox/registry-files";

function resolveSandboxScript(scriptRel: string) {
  // Scan every openclaw package root the shared resolver finds (symlinked launcher via realpath,
  // then cwd) and return the first that actually holds the script. The resolver follows npm/pnpm
  // global bins and version-manager links. Older packages may omit the requested script;
  // keep looking for a valid source-checkout cwd in that case.
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

async function runCodexBwrapNamespaceProbe(args: string[]): Promise<CodexBwrapNamespaceProbe> {
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
    return { ok: false, kind: "user", command: formatNamespaceProbeCommand(args), reason };
  }
}

async function probeCodexBwrapNamespaces(
  cfg: OpenClawConfig,
  options: SandboxHealthOptions,
  needsNetworkProbe: boolean,
): Promise<CodexBwrapNamespaceProbe> {
  const userProbe = await runCodexBwrapNamespaceProbe(["--user", "--map-root-user", "true"]);
  if (!userProbe.ok || !needsNetworkProbe) {
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

type EnabledSandboxSource = {
  /** Config path shown in doctor messages. */
  configPath: string;
  /** Agent id for agent-entry sources; undefined for agents.defaults.sandbox. */
  agentId?: string;
  /** Config path accepted by `openclaw config set` to disable this source. */
  disableConfigPath?: string;
  /** True when sandbox mode is off but a gateway role requires a sandbox. */
  roleRequired?: boolean;
  mode: string;
  backend: string;
  containerEngine: SandboxContainerEngine | undefined;
  dockerImage: string;
  /** True when the resolved sandbox network egress is disabled ("none" or empty). */
  networkEgressDisabled: boolean;
  browser: { enabled: boolean; image: string };
};

function resolveSandboxContainerEngine(backend: string): SandboxContainerEngine | undefined {
  if (backend === "podman") {
    return PODMAN_SANDBOX_ENGINE;
  }
  if (backend === "docker") {
    return DOCKER_SANDBOX_ENGINE;
  }
  return undefined;
}

function toEnabledSandboxSource(
  resolved: SandboxConfig,
  labels: Pick<EnabledSandboxSource, "configPath" | "agentId" | "disableConfigPath">,
): EnabledSandboxSource {
  const network = resolved.docker.network.trim().toLowerCase();
  return {
    ...labels,
    mode: resolved.mode,
    backend: resolved.backend,
    containerEngine: resolveSandboxContainerEngine(resolved.backend),
    dockerImage: resolved.docker.image,
    networkEgressDisabled: network === "" || network === "none",
    browser: { enabled: resolved.browser.enabled, image: resolved.browser.image },
  };
}

/** A role that requires a sandbox enables it for that role's sessions even when mode is off. */
function gatewayRoleRequiresSandbox(cfg: OpenClawConfig): boolean {
  return Object.values(cfg.gateway?.roles?.definitions ?? {}).some(
    (role) => role.sandbox === "required",
  );
}

/**
 * Enumerates every sandbox source doctor must treat as enabled: agents.defaults.sandbox (also
 * when a gateway role requires a sandbox while mode is off) plus each agent entry with its own
 * sandbox config whose resolved mode is not "off". Mode, backend, images, and network come from
 * resolveSandboxConfigForAgent — the same owner the sandbox runtime resolves through — so doctor
 * inspects exactly what sandboxed turns would use, including the "shared" scope's exclusion of
 * agent docker/browser overrides and the runtime's nullish image selection.
 */
function resolveEnabledSandboxSources(cfg: OpenClawConfig): EnabledSandboxSource[] {
  const sources: EnabledSandboxSource[] = [];
  const resolvedDefault = resolveSandboxConfigForAgent(cfg);
  const defaultLabels = {
    configPath: "agents.defaults.sandbox",
    disableConfigPath: "agents.defaults.sandbox.mode",
  };
  if (resolvedDefault.mode !== "off") {
    sources.push(toEnabledSandboxSource(resolvedDefault, defaultLabels));
  } else if (gatewayRoleRequiresSandbox(cfg)) {
    sources.push({
      ...toEnabledSandboxSource(resolvedDefault, defaultLabels),
      roleRequired: true,
    });
  }
  for (const { entry, source } of listAgentEntriesWithSource(cfg)) {
    if (!entry.sandbox) {
      continue;
    }
    const resolved = resolveSandboxConfigForAgent(cfg, entry.id);
    if (resolved.mode === "off") {
      continue;
    }
    sources.push(
      toEnabledSandboxSource(resolved, {
        configPath:
          source.kind === "entries"
            ? `agents.entries.${source.key}.sandbox`
            : `agents.list (id "${entry.id}")`,
        agentId: entry.id,
        disableConfigPath:
          source.kind === "entries" ? `agents.entries.${source.key}.sandbox.mode` : undefined,
      }),
    );
  }
  return sources;
}

export async function noteCodexBwrapNamespaceWarnings(
  cfg: OpenClawConfig,
  options: SandboxHealthOptions = {},
): Promise<void> {
  if (process.platform !== "linux") {
    return;
  }
  const engineAvailable = new Map<string, boolean>();
  const probed = new Map<
    string,
    {
      engine: SandboxContainerEngine;
      needsNetworkProbe: boolean;
      probe: CodexBwrapNamespaceProbe;
    }
  >();
  for (const source of resolveEnabledSandboxSources(cfg)) {
    // Codex's host namespace check follows sandbox mode, not gateway role requirements.
    const engine = source.roleRequired ? undefined : source.containerEngine;
    if (!engine) {
      continue;
    }
    if (!engineAvailable.has(engine.command)) {
      engineAvailable.set(engine.command, await isContainerEngineAvailable(engine.command));
    }
    if (!engineAvailable.get(engine.command)) {
      continue;
    }
    const signature = `${engine.command}:${String(source.networkEgressDisabled)}`;
    if (probed.has(signature)) {
      continue;
    }
    probed.set(signature, {
      engine,
      needsNetworkProbe: source.networkEgressDisabled,
      probe: await probeCodexBwrapNamespaces(cfg, options, source.networkEgressDisabled),
    });
  }
  for (const { engine, needsNetworkProbe, probe } of probed.values()) {
    if (!probe.ok) {
      noteCodexBwrapNamespaceFailure(engine, needsNetworkProbe, probe);
    }
  }
}

function noteCodexBwrapNamespaceFailure(
  engine: SandboxContainerEngine,
  needsNetworkProbe: boolean,
  probe: Exclude<CodexBwrapNamespaceProbe, { ok: true }>,
): void {
  const engineName = engine.displayName;
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
  const networkSentence = needsNetworkProbe
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
    if (imageMissing || (command === "docker" && isDockerDaemonUnavailable(stderr))) {
      return false;
    }
    throw error;
  }
}

async function handleMissingSandboxImage(
  params: {
    engineCommand: "docker" | "podman";
    kind: string;
    image: string;
    configPath: string;
    buildScript?: string;
  },
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
) {
  if (params.image.trim() === "") {
    // The runtime's nullish image selection preserves an explicitly empty configured value and
    // passes it through to container creation; building the default image cannot repair it.
    const warning = `Sandbox ${params.kind} image resolves to an empty string (${params.configPath}). Sandboxed turns will fail until a valid image is configured.`;
    note(warning, "Sandbox");
    return warning;
  }
  if (await containerImageExists(params.engineCommand, params.image)) {
    return undefined;
  }

  const buildHint =
    params.buildScript === "scripts/sandbox-image-build.sh"
      ? `Run ${formatCliCommand("openclaw doctor --fix")} to build it with ${params.buildScript}.`
      : params.buildScript
        ? `Build it with ${params.buildScript}.`
        : "Build or pull it first.";
  const warning = `Sandbox ${params.kind} image missing: ${params.image}. ${buildHint} Sandboxed turns will fail until the image is available.`;
  note(warning, "Sandbox");

  if (params.buildScript) {
    const build = await prompter.confirmRuntimeRepair({
      message: `Build ${params.kind} sandbox image now?`,
      initialValue: true,
    });
    if (build && (await runSandboxScript(params.buildScript, runtime))) {
      return undefined;
    }
  }
  return warning;
}

function unavailableContainerEngineWarning(
  source: EnabledSandboxSource,
  engine: SandboxContainerEngine,
): string[] {
  const name = engine.displayName;
  const firstLine = source.roleRequired
    ? `A gateway role requires a sandbox but ${name} is not available.`
    : source.agentId
      ? `Sandbox mode is enabled for agent "${source.agentId}" (${source.configPath}, mode: "${source.mode}") but ${name} is not available.`
      : `Sandbox mode is enabled (mode: "${source.mode}") but ${name} is not available.`;
  return [
    firstLine,
    engine.id === "docker"
      ? "Docker is required for sandbox mode to function."
      : `${name} is required by the selected sandbox backend.`,
    `Isolated sessions (automations, sub-agents) will fail without ${name}.`,
    "",
    "Options:",
    `- Install ${name} and restart the gateway`,
    source.roleRequired
      ? "- Stop requiring a sandbox: set gateway.roles.definitions.<role>.sandbox to inherit"
      : source.disableConfigPath
        ? `- Disable sandbox mode: openclaw config set ${source.disableConfigPath} off`
        : `- Disable sandbox mode for this agent (${source.configPath})`,
  ];
}

/**
 * Checks configured sandbox images and optionally runs bundled build scripts for missing defaults.
 *
 * Treats sandboxing as enabled for agents.defaults.sandbox (including gateway-role-required
 * sandboxes while mode is off) and for every agent entry whose resolved sandbox mode is not
 * "off". Non-container backends skip image checks.
 */
export async function maybeRepairSandboxImages(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: DoctorPrompter,
): Promise<string[]> {
  const sources = resolveEnabledSandboxSources(cfg);
  if (sources.length === 0) {
    return [];
  }
  const warnings: string[] = [];
  const engineAvailable = new Map<string, boolean>();
  const validatedEngines = new Set<string>();
  const checkedImages = new Set<string>();
  const notedNonContainerBackends = new Set<string>();
  const notedNonDockerBrowserEngines = new Set<string>();

  for (const source of sources) {
    const engine = source.containerEngine;
    if (!engine) {
      if (source.browser.enabled && !notedNonContainerBackends.has(source.backend)) {
        notedNonContainerBackends.add(source.backend);
        note(
          `Sandbox backend "${source.backend}" selected. Docker browser health checks are skipped; browser sandbox currently requires the docker backend.`,
          "Sandbox",
        );
      }
      continue;
    }

    if (!engineAvailable.has(engine.command)) {
      engineAvailable.set(engine.command, await isContainerEngineAvailable(engine.command));
    }
    if (!engineAvailable.get(engine.command)) {
      const lines = unavailableContainerEngineWarning(source, engine);
      note(lines.join("\n"), "Sandbox");
      warnings.push(lines.join("\n"));
      continue;
    }
    if (!validatedEngines.has(engine.command)) {
      validatedEngines.add(engine.command);
      await validateSandboxContainerEngineTarget(engine);
    }

    const baseImageKey = `${engine.command}:base:${source.dockerImage}`;
    if (!checkedImages.has(baseImageKey)) {
      checkedImages.add(baseImageKey);
      const baseWarning = await handleMissingSandboxImage(
        {
          engineCommand: engine.command,
          kind: "base",
          image: source.dockerImage,
          configPath: source.configPath,
          buildScript:
            engine.id !== "docker"
              ? undefined
              : source.dockerImage === DEFAULT_SANDBOX_COMMON_IMAGE
                ? "scripts/sandbox-common-setup.sh"
                : source.dockerImage === DEFAULT_SANDBOX_IMAGE
                  ? "scripts/sandbox-image-build.sh"
                  : undefined,
        },
        runtime,
        prompter,
      );
      if (baseWarning) {
        warnings.push(baseWarning);
      }
    }

    if (source.browser.enabled && engine.id === "docker") {
      const browserImageKey = `${engine.command}:browser:${source.browser.image}`;
      if (!checkedImages.has(browserImageKey)) {
        checkedImages.add(browserImageKey);
        const browserWarning = await handleMissingSandboxImage(
          {
            engineCommand: engine.command,
            kind: "browser",
            image: source.browser.image,
            configPath: source.configPath,
            buildScript: "scripts/sandbox-browser-setup.sh",
          },
          runtime,
          prompter,
        );
        if (browserWarning) {
          warnings.push(browserWarning);
        }
      }
    } else if (source.browser.enabled && !notedNonDockerBrowserEngines.has(engine.command)) {
      notedNonDockerBrowserEngines.add(engine.command);
      note(
        "Podman sandbox selected. Browser sandbox health checks are skipped because browser sandboxing requires the Docker engine.",
        "Sandbox",
      );
    }
  }
  return warnings;
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
  return `Run ${formatCliCommand("openclaw doctor --fix")} to archive retired registry files. Sandbox containers are recreated on demand; consult the archive for old container names before removing unused containers.`;
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
    action: "archive-retired-sandbox-registry",
    target: file.path,
    dryRunSafe: false,
  };
}

export async function maybeRepairSandboxRegistryFiles(
  prompter: Pick<DoctorPrompter, "shouldRepair">,
  assertCurrent: () => void,
): Promise<void> {
  const legacyFiles = await detectLegacySandboxRegistryFileIssues();
  if (legacyFiles.length === 0) {
    return;
  }
  if (prompter.shouldRepair) {
    for (const file of legacyFiles) {
      const stat = fs.lstatSync(file.path);
      const directory = stat.isDirectory() && !stat.isSymbolicLink();
      const paths = directory
        ? fs.readdirSync(file.path).map((name) => path.join(file.path, name))
        : [file.path];
      const result = await archiveRetiredStateFiles({
        label: "sandbox registry",
        paths,
        assertCurrent,
        recoveryInstructions:
          "Sandbox containers are recreated on demand. Consult this archive for old container names before manually removing unused containers.",
      });
      if (directory) {
        let archivePath = `${file.path}.migrated`;
        for (let index = 2; ; index++) {
          try {
            fs.lstatSync(archivePath);
          } catch (error) {
            if (hasErrnoCode(error, "ENOENT")) {
              break;
            }
            throw error;
          }
          archivePath = `${file.path}.migrated.${index}`;
        }
        assertCurrent();
        fs.renameSync(file.path, archivePath);
        result.warnings = result.warnings.map((warning) =>
          warning.replaceAll(`${file.path}${path.sep}`, `${archivePath}${path.sep}`),
        );
        result.warnings.push(`Retired sandbox registry directory archived at ${archivePath}.`);
      }
      note(result.warnings.join("\n"), "Sandbox");
    }
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
      `- ${agentPath} sandbox ${overrides.join("/")} overrides ignored.\n  scope resolves to "shared".`,
    );
  }

  if (warnings.length > 0) {
    note(warnings.join("\n"), "Sandbox");
  }
}
