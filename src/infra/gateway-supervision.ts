// Defines gateway lifecycle ownership shared by service, restart, and update paths.
import { isDefaultInstallIdentity, resolveNativeServiceProfileConflict } from "../config/paths.js";
import { resolveGatewayNativeServiceIdentityConflict } from "../daemon/constants.js";

const GATEWAY_SUPERVISOR_MODE_ENV = "OPENCLAW_SUPERVISOR_MODE";
export const EXTERNAL_SUPERVISOR_UPDATE_REQUIRED_REASON = "external-supervisor-update-required";
export const NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON =
  "service management skipped: non-default state dir or config path";

export type SupervisorAction =
  | "start"
  | "stop"
  | "restart"
  | "install"
  | "uninstall"
  | "repair"
  | "update";

export type SupervisorDisplayGuidance = {
  action: SupervisorAction;
  name: string;
  runFrom: string;
  command: string;
};

type SupervisorPreset = {
  name: string;
  runFrom: string;
  actions: Partial<Record<SupervisorAction, string>>;
};

const SUPERVISOR_PRESETS = {
  docker: {
    name: "Docker Compose",
    runFrom:
      "Docker host, in this deployment's Compose project directory, using its existing Compose file set and order",
    actions: {
      start: "docker compose up -d openclaw-gateway",
      stop: "docker compose stop openclaw-gateway",
      restart: "docker compose restart openclaw-gateway",
      repair: "docker compose up -d --force-recreate openclaw-gateway",
      update: "docker compose pull openclaw-gateway && docker compose up -d openclaw-gateway",
    },
  },
  clawctl: {
    name: "clawctl",
    runFrom: "Windows host session",
    actions: {
      start: "clawctl gateway-service start",
      stop: "clawctl gateway-service stop",
      restart: "clawctl gateway-service restart",
    },
  },
} satisfies Record<string, SupervisorPreset>;

export function resolveExternalSupervisorGuidance(
  action: SupervisorAction,
  env: NodeJS.ProcessEnv = process.env,
): SupervisorDisplayGuidance | undefined {
  const type = resolveGatewaySupervisorMode(env);
  if (type !== "docker" && type !== "clawctl") {
    return undefined;
  }
  const preset: SupervisorPreset = SUPERVISOR_PRESETS[type];
  const command = preset.actions[action];
  return command ? { action, name: preset.name, runFrom: preset.runFrom, command } : undefined;
}

export function isGatewayExternallySupervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveGatewaySupervisorMode(env) !== undefined;
}

export function formatExternalSupervisorActionRequired(
  action: string,
  guidance?: SupervisorDisplayGuidance,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const mode = resolveGatewaySupervisorMode(env) ?? "external";
  if (guidance) {
    return [
      `OpenClaw gateway lifecycle is managed by ${guidance.name} (${GATEWAY_SUPERVISOR_MODE_ENV}=${mode}).`,
      formatSupervisorCommand(guidance),
    ].join("\n");
  }
  return [
    `OpenClaw gateway lifecycle is managed by an external supervisor (${GATEWAY_SUPERVISOR_MODE_ENV}=${mode}).`,
    `Use that supervisor to ${action}.`,
  ].join(" ");
}

export function formatExternalSupervisorUpdateRequired(
  guidance?: SupervisorDisplayGuidance,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const mode = resolveGatewaySupervisorMode(env) ?? "external";
  if (guidance) {
    return [
      `OpenClaw self-update is disabled while gateway lifecycle is managed by ${guidance.name} (${GATEWAY_SUPERVISOR_MODE_ENV}=${mode}).`,
      formatSupervisorCommand(guidance),
    ].join("\n");
  }
  return [
    `OpenClaw self-update is disabled while gateway lifecycle is managed by an external supervisor (${GATEWAY_SUPERVISOR_MODE_ENV}=${mode}).`,
    "Use the external supervisor's update workflow so it can stop the gateway, update and finalize the runtime, then restart it safely.",
  ].join(" ");
}

export function assertGatewayServiceMutationAllowed(
  action: string,
  env: NodeJS.ProcessEnv = process.env,
  supervisorAction?: SupervisorAction,
): void {
  if (isGatewayExternallySupervised(env)) {
    throw new Error(
      formatExternalSupervisorActionRequired(
        action,
        supervisorAction ? resolveExternalSupervisorGuidance(supervisorAction, env) : undefined,
        env,
      ),
    );
  }
  const conflictingProfile = resolveNativeServiceProfileConflict(env);
  if (conflictingProfile) {
    if (conflictingProfile !== conflictingProfile.toLowerCase()) {
      const platformName = process.platform === "win32" ? "Windows" : "macOS";
      throw new Error(
        `service management skipped: ${platformName} profile "${conflictingProfile}" is not lowercase-safe for case-insensitive state and native-service paths. Use a lowercase profile name to ${action}, or keep this profile runtime-only without a native service.`,
      );
    }
    throw new Error(
      `service management skipped: macOS profile "${conflictingProfile}" conflicts with a reserved LaunchAgent identity. Choose a different profile name to ${action}.`,
    );
  }
  const serviceIdentityConflict = resolveGatewayNativeServiceIdentityConflict(env);
  if (serviceIdentityConflict) {
    const platformName =
      process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux";
    throw new Error(
      `service management skipped: named profiles cannot override ${serviceIdentityConflict.envKey} for ${platformName} service management. Unset ${serviceIdentityConflict.envKey} so OpenClaw derives the native service identity from OPENCLAW_PROFILE to ${action}, or keep this profile runtime-only without a native service.`,
    );
  }
  if (!isDefaultInstallIdentity(env)) {
    throw new Error(
      `${NON_DEFAULT_INSTALL_SERVICE_SKIP_REASON}. Rerun with HOME set to the OS account home, without OPENCLAW_HOME, and with OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH either unset or pointing at the canonical paths for that account home and profile to ${action}.`,
    );
  }
}

export function resolveGatewayServiceMutationError(
  action: string,
  env: NodeJS.ProcessEnv = process.env,
  supervisorAction?: SupervisorAction,
): Error | null {
  try {
    assertGatewayServiceMutationAllowed(action, env, supervisorAction);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function formatSupervisorCommand(guidance: SupervisorDisplayGuidance): string {
  const action = guidance.action.charAt(0).toUpperCase() + guidance.action.slice(1);
  return `${action} (${guidance.runFrom}): ${guidance.command}`;
}

function resolveGatewaySupervisorMode(env: NodeJS.ProcessEnv) {
  const mode = env[GATEWAY_SUPERVISOR_MODE_ENV]?.trim().toLowerCase();
  return mode === "external" || mode === "docker" || mode === "clawctl" ? mode : undefined;
}
