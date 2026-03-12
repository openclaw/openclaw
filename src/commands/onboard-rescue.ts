import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import {
  ensureAuthProfileStore,
  loadAuthProfileStore,
  saveAuthProfileStore,
  type AuthProfileStore,
} from "../agents/auth-profiles.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import { isValidProfileName } from "../cli/profile-utils.js";
import type { OpenClawConfig } from "../config/config.js";
import { createConfigIO } from "../config/io.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { ToolProfileId } from "../config/types.tools.js";
import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import { resolveGatewayService } from "../daemon/service.js";
import { callGateway } from "../gateway/call.js";
import { probeGateway } from "../gateway/probe.js";
import { classifyPortListener, formatPortDiagnostics, inspectPortUsage } from "../infra/ports.js";
import {
  DEFAULT_RESCUE_INTERVAL_MS,
  DEFAULT_RESCUE_TIMEOUT_SECONDS,
  RESCUE_WATCHDOG_AGENT_ID,
  buildRescueProfileEnv,
  canEnableRescueWatchdog,
  resolveMonitoredProfileName,
} from "../rescue/watchdog-shared.js";
import { DEFAULT_AGENT_ID } from "../routing/session-key.js";
import { resolveUserPath, sleep } from "../utils.js";
import { buildGatewayInstallPlan, gatewayInstallErrorHint } from "./daemon-install-helpers.js";
import { DEFAULT_GATEWAY_DAEMON_RUNTIME, type GatewayDaemonRuntime } from "./daemon-runtime.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";
import { randomToken, waitForGatewayReachable } from "./onboard-helpers.js";

export { canEnableRescueWatchdog, resolveMonitoredProfileName } from "../rescue/watchdog-shared.js";

const RESCUE_JOB_NAME_PREFIX = "Rescue watchdog";
const RESCUE_PROFILE_SUFFIX = "-rescue";
const PROFILE_NAME_MAX_LENGTH = 64;
const TRUNCATED_RESCUE_HASH_LENGTH = 8;
const RESCUE_GATEWAY_READY_TIMEOUT_MS = 15_000;
const RESCUE_GATEWAY_READY_POLL_MS = 250;

type RescueCronListResponse = {
  jobs?: Array<{
    id?: string;
    name?: string;
    payload?: { kind?: string; monitoredProfile?: string };
  }>;
  hasMore?: boolean;
  nextOffset?: number | null;
};

export type RescueWatchdogSetupResult = {
  enabled: boolean;
  monitoredProfile: string;
  rescueProfile: string;
  rescuePort: number;
  rescueWorkspace: string;
  cronJobId?: string;
  cronAction?: "created" | "updated";
};

function assertValidMonitoredProfileName(raw?: string): string {
  const monitoredProfile = resolveMonitoredProfileName(raw);
  if (monitoredProfile !== "default" && !isValidProfileName(monitoredProfile)) {
    throw new Error(
      `Invalid monitored profile "${monitoredProfile}" (use letters, numbers, "_" or "-" only).`,
    );
  }
  return monitoredProfile;
}

export function resolveRescueProfileName(monitoredProfile: string): string {
  const normalized = assertValidMonitoredProfileName(monitoredProfile);
  if (normalized === "default") {
    return "rescue";
  }
  const maxBaseLength = PROFILE_NAME_MAX_LENGTH - RESCUE_PROFILE_SUFFIX.length;
  if (normalized.length <= maxBaseLength) {
    return `${normalized}${RESCUE_PROFILE_SUFFIX}`;
  }
  // Long monitored profiles need a stable disambiguator so rescue state does not
  // collide when multiple valid profile names share the same truncated prefix.
  const hashSuffix = `-${createHash("sha256").update(normalized).digest("hex").slice(0, TRUNCATED_RESCUE_HASH_LENGTH)}`;
  const hashedBaseLength =
    PROFILE_NAME_MAX_LENGTH - RESCUE_PROFILE_SUFFIX.length - hashSuffix.length;
  const base = normalized.slice(0, Math.max(1, hashedBaseLength));
  return `${base}${hashSuffix}${RESCUE_PROFILE_SUFFIX}`;
}

function resolveRescueWorkspace(mainWorkspace: string): string {
  return `${resolveUserPath(mainWorkspace)}${RESCUE_PROFILE_SUFFIX}`;
}

function resolveRescueGatewayToken(existingConfig: OpenClawConfig | undefined): string {
  const existing = existingConfig?.gateway?.auth?.token;
  if (typeof existing === "string" && existing.trim()) {
    return existing.trim();
  }
  return `rescue-${randomToken()}`;
}

function resolveRescueToolProfile(sourceProfile: unknown, existingProfile: unknown): ToolProfileId {
  const candidate =
    typeof sourceProfile === "string" && sourceProfile.trim()
      ? sourceProfile.trim()
      : typeof existingProfile === "string" && existingProfile.trim()
        ? existingProfile.trim()
        : "";
  if (candidate === "full" || candidate === "coding") {
    return candidate;
  }
  return "coding";
}

function mergeRescueAuthRecords<T>(
  existing: Record<string, T> | undefined,
  source: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!existing && !source) {
    return undefined;
  }
  return {
    ...existing,
    ...source,
  };
}

function mergeRescueAuthStores(
  existing: AuthProfileStore,
  source: AuthProfileStore,
): AuthProfileStore {
  return {
    version: Math.max(existing.version, source.version),
    profiles: {
      ...existing.profiles,
      ...source.profiles,
    },
    order: mergeRescueAuthRecords(existing.order, source.order),
    lastGood: mergeRescueAuthRecords(existing.lastGood, source.lastGood),
    usageStats: mergeRescueAuthRecords(existing.usageStats, source.usageStats),
  };
}

function mergeRescueEnvConfig(
  existingEnv: OpenClawConfig["env"],
  sourceEnv: OpenClawConfig["env"],
): OpenClawConfig["env"] {
  if (!existingEnv && !sourceEnv) {
    return undefined;
  }
  return {
    ...existingEnv,
    ...sourceEnv,
    vars: {
      ...existingEnv?.vars,
      ...sourceEnv?.vars,
    },
    shellEnv: {
      ...existingEnv?.shellEnv,
      ...sourceEnv?.shellEnv,
    },
  };
}

function buildRescueWatchdogMarker(monitoredProfile: string) {
  return {
    managed: true,
    monitoredProfile: resolveMonitoredProfileName(monitoredProfile),
    agentId: RESCUE_WATCHDOG_AGENT_ID,
  } satisfies NonNullable<NonNullable<OpenClawConfig["wizard"]>["rescueWatchdog"]>;
}

function isManagedRescueWatchdogConfig(
  cfg: OpenClawConfig | undefined,
  monitoredProfile: string,
): boolean {
  const marker = cfg?.wizard?.rescueWatchdog;
  return (
    marker?.managed === true &&
    marker.monitoredProfile === resolveMonitoredProfileName(monitoredProfile) &&
    marker.agentId === RESCUE_WATCHDOG_AGENT_ID
  );
}

function assertRescueProfileOwnership(params: {
  monitoredProfile: string;
  rescueProfile: string;
  existingRescueConfig?: OpenClawConfig;
}) {
  if (!params.existingRescueConfig) {
    return;
  }
  if (isManagedRescueWatchdogConfig(params.existingRescueConfig, params.monitoredProfile)) {
    return;
  }
  throw new Error(
    [
      `Rescue watchdog refused to overwrite the existing "${params.rescueProfile}" profile.`,
      `That profile is not marked as a rescue watchdog for "${resolveMonitoredProfileName(params.monitoredProfile)}".`,
      "Rename or remove the existing profile before enabling --rescue-watchdog.",
    ].join("\n"),
  );
}

function upsertAgentConfig(params: {
  agents: OpenClawConfig["agents"];
  nextAgent: AgentConfig;
}): OpenClawConfig["agents"] {
  const existingList = params.agents?.list ?? [];
  const filtered = existingList.filter((agent) => agent.id !== params.nextAgent.id);
  return {
    ...params.agents,
    list: [...filtered, params.nextAgent],
  };
}

function buildRescueWatchdogAgentConfig(rescueWorkspace: string): AgentConfig {
  return {
    id: RESCUE_WATCHDOG_AGENT_ID,
    name: "Rescue Watchdog",
    workspace: rescueWorkspace,
    skills: [],
    tools: {
      profile: "minimal",
      allow: [],
      deny: ["*"],
    },
  };
}

function resolveConfiguredRescueGatewayPort(
  existingConfig: OpenClawConfig | undefined,
): number | undefined {
  const candidate = existingConfig?.gateway?.port;
  if (typeof candidate !== "number" || !Number.isInteger(candidate)) {
    return undefined;
  }
  if (candidate < 1024 || candidate > 65_535) {
    return undefined;
  }
  return candidate;
}

async function allocateLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        if (!addr || typeof addr === "string") {
          reject(new Error("failed to allocate rescue gateway port"));
          return;
        }
        resolve(addr.port);
      });
    });
  });
}

function looksLikeAuthClose(code: number | undefined, reason: string | undefined): boolean {
  if (code !== 1008) {
    return false;
  }
  const normalized = (reason ?? "").toLowerCase();
  return (
    normalized.includes("auth") ||
    normalized.includes("token") ||
    normalized.includes("password") ||
    normalized.includes("scope")
  );
}

export async function resolveRescueGatewayPort(
  mainPort: number,
  existingConfig?: OpenClawConfig,
): Promise<number> {
  const existingPort = resolveConfiguredRescueGatewayPort(existingConfig);
  if (existingPort && existingPort !== mainPort) {
    return existingPort;
  }
  try {
    return await allocateLoopbackPort();
  } catch {
    const preferred = mainPort + 1000;
    if (preferred <= 65_535) {
      return preferred;
    }
    const fallback = mainPort + 20;
    if (fallback <= 65_535) {
      return fallback;
    }
    return Math.max(1024, mainPort - 1000);
  }
}

async function waitForRescueGatewayIdentity(params: {
  service: ReturnType<typeof resolveGatewayService>;
  rescueEnv: NodeJS.ProcessEnv;
  rescuePort: number;
}) {
  const deadlineAt = Date.now() + RESCUE_GATEWAY_READY_TIMEOUT_MS;
  const wsUrl = `ws://127.0.0.1:${params.rescuePort}`;
  let lastRuntimeDetail = "unknown";
  let lastPortDiagnostics = `Port ${params.rescuePort} is not listening yet.`;

  while (Date.now() < deadlineAt) {
    const runtime: GatewayServiceRuntime = await params.service
      .readRuntime(params.rescueEnv)
      .catch(() => ({ status: "unknown" }));
    lastRuntimeDetail = [
      runtime.status ? `status=${runtime.status}` : null,
      runtime.pid != null ? `pid=${runtime.pid}` : null,
      runtime.state ? `state=${runtime.state}` : null,
      runtime.detail ? `detail=${runtime.detail}` : null,
    ]
      .filter(Boolean)
      .join(", ");

    const portUsage = await inspectPortUsage(params.rescuePort).catch(() => ({
      port: params.rescuePort,
      status: "unknown" as const,
      listeners: [],
      hints: [],
      errors: [],
    }));
    lastPortDiagnostics =
      portUsage.status === "busy"
        ? formatPortDiagnostics(portUsage).join("\n")
        : `Port ${params.rescuePort} status: ${portUsage.status}.`;

    const listenerOwnedByRuntime =
      runtime.status === "running" &&
      portUsage.status === "busy" &&
      portUsage.listeners.some(
        (listener) =>
          (typeof runtime.pid === "number" &&
            (listener.pid === runtime.pid || listener.ppid === runtime.pid)) ||
          classifyPortListener(listener, params.rescuePort) === "gateway",
      );
    // Some supervisors can start a healthy gateway before exposing stable
    // runtime/PID metadata. Accept a probe-confirmed gateway in that case.
    const ownershipMetadataUnavailable =
      (runtime.status === "unknown" || runtime.pid == null) &&
      (portUsage.status !== "busy" || portUsage.listeners.length === 0);

    const probe = await probeGateway({
      url: wsUrl,
      timeoutMs: 1_000,
    }).catch(() => null);
    const probeLooksLikeGateway =
      probe?.ok === true || looksLikeAuthClose(probe?.close?.code, probe?.close?.reason);

    if (probeLooksLikeGateway && (listenerOwnedByRuntime || ownershipMetadataUnavailable)) {
      return;
    }

    await sleep(RESCUE_GATEWAY_READY_POLL_MS);
  }

  throw new Error(
    [
      `Rescue gateway failed to prove ownership of loopback port ${params.rescuePort} before token provisioning.`,
      `Service runtime: ${lastRuntimeDetail}`,
      lastPortDiagnostics,
    ].join("\n"),
  );
}

function normalizeServiceEnvironment(environment?: Record<string, string | undefined>) {
  return Object.entries(environment ?? {})
    .filter(([, value]) => value !== undefined)
    .toSorted(([left], [right]) => left.localeCompare(right));
}

function serviceCommandMatchesPlan(params: {
  current: {
    programArguments: string[];
    workingDirectory?: string;
    environment?: Record<string, string>;
  } | null;
  expected: {
    programArguments: string[];
    workingDirectory?: string;
    environment?: Record<string, string | undefined>;
  };
}) {
  if (!params.current) {
    return false;
  }
  const expectedEnvironment = Object.fromEntries(
    Object.entries(params.expected.environment ?? {}).filter(([, value]) => value !== undefined),
  );
  return (
    JSON.stringify(params.current.programArguments) ===
      JSON.stringify(params.expected.programArguments) &&
    (params.current.workingDirectory ?? "") === (params.expected.workingDirectory ?? "") &&
    JSON.stringify(normalizeServiceEnvironment(params.current.environment)) ===
      JSON.stringify(normalizeServiceEnvironment(expectedEnvironment))
  );
}

export function buildRescueWatchdogConfig(params: {
  sourceConfig: OpenClawConfig;
  existingRescueConfig?: OpenClawConfig;
  monitoredProfile: string;
  rescueWorkspace: string;
  rescuePort: number;
  rescueToken: string;
}): OpenClawConfig {
  const {
    sourceConfig,
    existingRescueConfig,
    monitoredProfile,
    rescueWorkspace,
    rescuePort,
    rescueToken,
  } = params;
  const existing = existingRescueConfig ?? {};
  const rescueAgent = buildRescueWatchdogAgentConfig(rescueWorkspace);
  return {
    ...existing,
    agents: upsertAgentConfig({
      agents: {
        ...existing.agents,
        defaults: {
          ...sourceConfig.agents?.defaults,
          ...existing.agents?.defaults,
          workspace: rescueWorkspace,
          heartbeat: {
            ...sourceConfig.agents?.defaults?.heartbeat,
            ...existing.agents?.defaults?.heartbeat,
            every: "0m",
          },
        },
      },
      nextAgent: rescueAgent,
    }),
    auth: sourceConfig.auth ?? existing.auth,
    env: mergeRescueEnvConfig(existing.env, sourceConfig.env),
    // Preserve rescue scheduler settings, but always re-enable cron on managed
    // rescue profiles so watchdog jobs run after onboarding re-provisioning.
    cron: existing.cron ? { ...existing.cron, enabled: true } : undefined,
    models: sourceConfig.models ?? existing.models,
    secrets: sourceConfig.secrets ?? existing.secrets,
    skills: sourceConfig.skills ?? existing.skills,
    tools: {
      ...sourceConfig.tools,
      ...existing.tools,
      profile: resolveRescueToolProfile(sourceConfig.tools?.profile, existing.tools?.profile),
    },
    gateway: {
      ...existing.gateway,
      mode: "local",
      port: rescuePort,
      bind: "loopback",
      remote: undefined,
      tailscale: {
        mode: "off",
        resetOnExit: false,
      },
      tls: undefined,
      auth: {
        mode: "token",
        token: rescueToken,
      },
    },
    wizard: {
      ...existing.wizard,
      rescueWatchdog: buildRescueWatchdogMarker(monitoredProfile),
    },
  };
}

async function loadExistingRescueConfig(
  env: NodeJS.ProcessEnv,
): Promise<OpenClawConfig | undefined> {
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (!configPath) {
    return undefined;
  }
  try {
    await fs.access(configPath);
  } catch {
    return undefined;
  }
  const io = createConfigIO({ env });
  try {
    return io.loadConfig();
  } catch (error) {
    throw new Error(
      `Rescue watchdog setup failed: existing rescue profile config at "${configPath}" could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function syncRescueAuthProfiles(params: { rescueEnv: NodeJS.ProcessEnv }) {
  const rescueStateDir = params.rescueEnv.OPENCLAW_STATE_DIR?.trim();
  if (!rescueStateDir) {
    throw new Error("Rescue watchdog setup failed: rescue profile state dir was not resolved.");
  }
  const rescueAgentDir = path.join(rescueStateDir, "agents", DEFAULT_AGENT_ID, "agent");
  await fs.mkdir(rescueAgentDir, { recursive: true });
  const existingRescueStore = ensureAuthProfileStore(rescueAgentDir, {
    allowKeychainPrompt: false,
  });
  const sourceStore = loadAuthProfileStore();
  // Keep rescue-only credentials, but let the monitored profile's latest auth
  // entries override stale duplicates on onboarding reruns.
  saveAuthProfileStore(mergeRescueAuthStores(existingRescueStore, sourceStore), rescueAgentDir);
}

async function ensureRescueWorkspace(params: {
  rescueWorkspace: string;
  rescueEnv: NodeJS.ProcessEnv;
  note?: (message: string, title?: string) => Promise<void>;
}) {
  const workspace = await ensureAgentWorkspace({
    dir: params.rescueWorkspace,
    ensureBootstrapFiles: true,
  });
  const sessionsDir = resolveSessionTranscriptsDirForAgent(DEFAULT_AGENT_ID, params.rescueEnv);
  await fs.mkdir(sessionsDir, { recursive: true });
  await params.note?.(
    [`Workspace: ${workspace.dir}`, `Sessions: ${sessionsDir}`].join("\n"),
    "Rescue watchdog",
  );
}

async function ensureRescueCronJob(params: {
  rescuePort: number;
  rescueToken: string;
  monitoredProfile: string;
}): Promise<{ cronJobId?: string; cronAction?: "created" | "updated" }> {
  const wsUrl = `ws://127.0.0.1:${params.rescuePort}`;
  const name = `${RESCUE_JOB_NAME_PREFIX} (${resolveMonitoredProfileName(params.monitoredProfile)})`;
  const expectedMonitored = resolveMonitoredProfileName(params.monitoredProfile);
  const pageSize = 100;
  let offset = 0;
  let existingManagedWatchdog:
    | { id?: string; name?: string; payload?: { kind?: string; monitoredProfile?: string } }
    | undefined;
  while (true) {
    const page = await callGateway<RescueCronListResponse>({
      url: wsUrl,
      token: params.rescueToken,
      method: "cron.list",
      params: {
        includeDisabled: true,
        limit: pageSize,
        offset,
        query: name,
      },
    });
    const matchingManagedJob = page.jobs?.find(
      (job) =>
        job.name === name &&
        job.payload?.kind === "rescueWatchdog" &&
        job.payload.monitoredProfile === expectedMonitored,
    );
    if (matchingManagedJob) {
      existingManagedWatchdog = matchingManagedJob;
      break;
    }
    if (page.hasMore !== true) {
      break;
    }
    if (typeof page.nextOffset !== "number" || page.nextOffset <= offset) {
      break;
    }
    offset = page.nextOffset;
  }
  const payload = {
    agentId: RESCUE_WATCHDOG_AGENT_ID,
    name,
    description:
      "Auto-restarts the primary OpenClaw profile when the main gateway becomes unhealthy.",
    enabled: true,
    schedule: {
      kind: "every",
      everyMs: DEFAULT_RESCUE_INTERVAL_MS,
    },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "rescueWatchdog",
      monitoredProfile: resolveMonitoredProfileName(params.monitoredProfile),
      timeoutSeconds: DEFAULT_RESCUE_TIMEOUT_SECONDS,
    },
    delivery: {
      mode: "none",
    },
  };

  // Only update an existing job if it is actually a rescue watchdog for the
  // same monitored profile. We scan all cron.list pages first so a user-created
  // same-name job cannot hide a managed watchdog entry that appears later.
  if (existingManagedWatchdog?.id) {
    await callGateway({
      url: wsUrl,
      token: params.rescueToken,
      method: "cron.update",
      params: {
        id: existingManagedWatchdog.id,
        patch: payload,
      },
    });
    return { cronJobId: existingManagedWatchdog.id, cronAction: "updated" };
  }

  const created = await callGateway<{ id?: string }>({
    url: wsUrl,
    token: params.rescueToken,
    method: "cron.add",
    params: payload,
  });
  return { cronJobId: created.id, cronAction: "created" };
}

export async function setupRescueWatchdog(params: {
  sourceConfig: OpenClawConfig;
  workspaceDir: string;
  mainPort: number;
  monitoredProfile?: string;
  runtime: GatewayDaemonRuntime;
  output: {
    log: (message: string) => void;
    note?: (message: string, title?: string) => Promise<void>;
  };
}): Promise<RescueWatchdogSetupResult> {
  const monitoredProfile = assertValidMonitoredProfileName(params.monitoredProfile);
  if (!canEnableRescueWatchdog(monitoredProfile)) {
    throw new Error(
      `Rescue watchdog is not supported while onboarding the "${monitoredProfile}" profile.`,
    );
  }

  const rescueProfile = resolveRescueProfileName(monitoredProfile);
  const rescueEnv = buildRescueProfileEnv(rescueProfile);
  const existingRescueConfig = await loadExistingRescueConfig(rescueEnv);
  assertRescueProfileOwnership({
    monitoredProfile,
    rescueProfile,
    existingRescueConfig,
  });
  const rescuePort = await resolveRescueGatewayPort(params.mainPort, existingRescueConfig);
  const rescueWorkspace = resolveRescueWorkspace(params.workspaceDir);
  const rescueToken = resolveRescueGatewayToken(existingRescueConfig);
  const rescueConfig = buildRescueWatchdogConfig({
    sourceConfig: params.sourceConfig,
    existingRescueConfig,
    monitoredProfile,
    rescueWorkspace,
    rescuePort,
    rescueToken,
  });

  const rescueIo = createConfigIO({ env: rescueEnv });
  await rescueIo.writeConfigFile(rescueConfig);
  await ensureRescueWorkspace({
    rescueWorkspace,
    rescueEnv,
    note: params.output.note,
  });
  await syncRescueAuthProfiles({ rescueEnv });

  const tokenResolution = await resolveGatewayInstallToken({
    config: rescueConfig,
    env: rescueEnv,
  });
  for (const warning of tokenResolution.warnings) {
    params.output.log(warning);
  }
  if (tokenResolution.unavailableReason) {
    throw new Error(tokenResolution.unavailableReason);
  }

  const expectedInstallPlan = await buildGatewayInstallPlan({
    env: rescueEnv,
    port: rescuePort,
    runtime: params.runtime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME,
    warn: (message) => params.output.log(message),
    config: rescueConfig,
  });

  const service = resolveGatewayService();
  const loaded = await service.isLoaded({ env: rescueEnv });
  if (!loaded) {
    try {
      await service.install({
        env: rescueEnv,
        stdout: process.stdout,
        programArguments: expectedInstallPlan.programArguments,
        workingDirectory: expectedInstallPlan.workingDirectory,
        environment: expectedInstallPlan.environment,
      });
    } catch (error) {
      throw new Error(
        `Rescue gateway install failed: ${error instanceof Error ? error.message : String(error)}\n${gatewayInstallErrorHint()}`,
        { cause: error },
      );
    }
  } else {
    const currentCommand = await service.readCommand(rescueEnv).catch(() => null);
    const needsReinstall = !serviceCommandMatchesPlan({
      current: currentCommand,
      expected: expectedInstallPlan,
    });
    if (needsReinstall) {
      try {
        await service.install({
          env: rescueEnv,
          stdout: process.stdout,
          programArguments: expectedInstallPlan.programArguments,
          workingDirectory: expectedInstallPlan.workingDirectory,
          environment: expectedInstallPlan.environment,
        });
      } catch (error) {
        throw new Error(
          `Rescue gateway update failed: ${error instanceof Error ? error.message : String(error)}\n${gatewayInstallErrorHint()}`,
          { cause: error },
        );
      }
    } else {
      await service.restart({
        env: rescueEnv,
        stdout: process.stdout,
      });
    }
  }

  await waitForRescueGatewayIdentity({
    service,
    rescueEnv,
    rescuePort,
  });
  await waitForGatewayReachable({
    url: `ws://127.0.0.1:${rescuePort}`,
    token: rescueToken,
    deadlineMs: 15_000,
  });
  const cron = await ensureRescueCronJob({
    rescuePort,
    rescueToken,
    monitoredProfile,
  });

  await params.output.note?.(
    [
      `Primary profile: ${monitoredProfile}`,
      `Rescue profile: ${rescueProfile}`,
      `Gateway port: ${rescuePort}`,
      `Inspect: ${formatCliCommand(`openclaw --profile ${rescueProfile} gateway status`)}`,
      `Cron runs: ${formatCliCommand(`openclaw --profile ${rescueProfile} cron runs --id ${cron.cronJobId ?? "<jobId>"}`)}`,
    ].join("\n"),
    "Rescue watchdog",
  );

  return {
    enabled: true,
    monitoredProfile,
    rescueProfile,
    rescuePort,
    rescueWorkspace,
    ...cron,
  };
}
