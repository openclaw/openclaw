import fs from "node:fs/promises";
import type { EnvironmentSummary } from "../../../packages/gateway-protocol/src/index.js";
import type { DesktopHostConfig } from "../../config/types.desktop.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import type { RfbAttachment } from "./attachment.js";
import { getHostDesktopGuidance } from "./host-guidance.js";
import { HostDesktopCredentialsRequiredError } from "./host-source-errors.js";
import {
  createManagedLinuxDesktop,
  type DesktopComputerLease,
  type ManagedLinuxDesktop,
  type ManagedLinuxDesktopStatus,
} from "./managed-linux.js";
import { mintDesktopObserverToken } from "./observe-bridge.js";
import type { DesktopObserveRequester } from "./observe-requester.js";
import { classifyRfbSecurity, probeRfbServer, type RfbProbeResult } from "./rfb-probe.js";
import type { DesktopSessionRegistry } from "./session-registry.js";

const DEFAULT_HOST_DESKTOP_PORT = 5900;
const HOST_DESKTOP_PROBE_TIMEOUT_MS = 1_500;

export type HostDesktopAcquireResult = {
  attachment: RfbAttachment;
  auth: "vnc-password" | "ard-account";
  vncPassword?: string;
};

export type HostDesktopStatus =
  | { enabled: false; state: "disabled"; port: number }
  | { enabled: true; state: "attached"; port: number; security: string }
  | { enabled: true; state: "unavailable"; port: number; security?: string }
  | {
      enabled: true;
      state: "managed";
      managedState: ManagedLinuxDesktopStatus["state"] | "unknown";
      port: number;
      display?: number;
      error?: string;
      security?: "VncAuth";
    };

export type HostDesktopInspection = {
  status: HostDesktopStatus;
  detail: string;
  unavailableReason?: "not-listening" | "not-rfb" | "unsupported";
};

function nonRfbError(port: number): string {
  return `desktop.host.port ${port} is occupied by a non-VNC service; configure desktop.host.port for the loopback VNC server, then retry`;
}

function unavailableError(port: number, platform: NodeJS.Platform): string {
  return `gateway host desktop is unavailable at 127.0.0.1:${port}. ${getHostDesktopGuidance(platform)}`;
}

function managedPlatformError(platform: NodeJS.Platform): string {
  return `desktop.host.managed is available only on Linux; disable it on ${platform} or configure desktop.host.port for an existing loopback VNC server`;
}

function managedInspection(managedStatus: ManagedLinuxDesktopStatus): HostDesktopInspection {
  if (managedStatus.state === "running") {
    return {
      status: {
        enabled: true,
        state: "managed",
        managedState: "running",
        display: managedStatus.display,
        port: managedStatus.port,
        security: "VncAuth",
      },
      detail: `managed (running, display :${managedStatus.display}, port ${managedStatus.port}, security: VncAuth)`,
    };
  }
  if (managedStatus.state === "failed") {
    return {
      status: {
        enabled: true,
        state: "managed",
        managedState: "failed",
        port: managedStatus.port ?? DEFAULT_HOST_DESKTOP_PORT,
        ...(managedStatus.display !== undefined ? { display: managedStatus.display } : {}),
        error: managedStatus.error,
      },
      detail: `managed (failed: ${managedStatus.error})`,
      unavailableReason: "unsupported",
    };
  }
  const startingCoordinates =
    managedStatus.state === "starting"
      ? {
          port: managedStatus.port ?? DEFAULT_HOST_DESKTOP_PORT,
          ...(managedStatus.display !== undefined ? { display: managedStatus.display } : {}),
        }
      : { port: DEFAULT_HOST_DESKTOP_PORT };
  return {
    status: {
      enabled: true,
      state: "managed",
      managedState: managedStatus.state,
      ...startingCoordinates,
    },
    detail: managedStatus.state === "starting" ? "managed (starting)" : "managed (not started)",
  };
}

function configuredManagedInspection(): HostDesktopInspection {
  return {
    status: {
      enabled: true,
      state: "managed",
      managedState: "unknown",
      port: DEFAULT_HOST_DESKTOP_PORT,
    },
    detail: "managed (configured; runtime state is available from the running Gateway status)",
  };
}

function securityLabel(probe: Extract<RfbProbeResult, { kind: "rfb" }>): string {
  const auth = classifyRfbSecurity(probe.securityTypes);
  if (auth === "vnc-password") {
    return "VncAuth";
  }
  if (auth === "ard-account") {
    return "ARD";
  }
  if (auth === "none") {
    return "None";
  }
  return probe.securityTypes.includes(19) ? "VeNCrypt" : "unsupported";
}

type HostDesktopInspectionParams = {
  config?: DesktopHostConfig;
  platform?: NodeJS.Platform;
  managedDesktop?: ManagedLinuxDesktop;
  probeRfb?: typeof probeRfbServer;
};

/** Probes the configured host desktop without reading or exposing password material. */
export async function inspectHostDesktop(
  params: HostDesktopInspectionParams,
): Promise<HostDesktopInspection> {
  if (params.config?.enabled !== true) {
    return {
      status: {
        enabled: false,
        state: "disabled",
        port: params.config?.port ?? DEFAULT_HOST_DESKTOP_PORT,
      },
      detail: "disabled; enable the Desktop lab with desktop.host.enabled=true",
    };
  }
  return inspectConfiguredHostDesktop(params);
}

/** Setup inspection discovers a source without enabling access or starting a desktop. */
export async function inspectHostDesktopSetup(
  params: Omit<HostDesktopInspectionParams, "managedDesktop">,
): Promise<NonNullable<EnvironmentSummary["desktopSetup"]>> {
  const inspection = await inspectConfiguredHostDesktop(params);
  if (inspection.status.state === "attached") {
    return { state: "ready" };
  }
  if (inspection.status.state === "managed") {
    return { state: "managed" };
  }
  return {
    state: inspection.unavailableReason === "not-listening" ? "needs-server" : "unsupported",
    detail: inspection.detail,
  };
}

async function inspectConfiguredHostDesktop(
  params: HostDesktopInspectionParams,
): Promise<HostDesktopInspection> {
  const port = params.config?.port ?? DEFAULT_HOST_DESKTOP_PORT;
  const platform = params.platform ?? process.platform;
  const probe = await (params.probeRfb ?? probeRfbServer)({
    host: "127.0.0.1",
    port,
    timeoutMs: HOST_DESKTOP_PROBE_TIMEOUT_MS,
  });
  if (probe.kind === "unreachable" || probe.kind === "timeout") {
    if (params.config?.port === undefined && params.config?.managed === true) {
      if (platform !== "linux") {
        return {
          status: { enabled: true, state: "unavailable", port },
          detail: managedPlatformError(platform),
          unavailableReason: "unsupported",
        };
      }
      return params.managedDesktop
        ? managedInspection(params.managedDesktop.status())
        : configuredManagedInspection();
    }
    return {
      status: { enabled: true, state: "unavailable", port },
      detail: unavailableError(port, platform),
      unavailableReason: "not-listening",
    };
  }
  if (probe.kind === "not-rfb") {
    return {
      status: { enabled: true, state: "unavailable", port },
      detail: nonRfbError(port),
      unavailableReason: "not-rfb",
    };
  }
  const security = securityLabel(probe);
  const auth = classifyRfbSecurity(probe.securityTypes);
  if (auth === "vnc-password" || auth === "ard-account") {
    return {
      status: { enabled: true, state: "attached", port, security },
      detail: `attached (127.0.0.1:${port}, security: ${security})`,
    };
  }
  const detail =
    auth === "none"
      ? `unavailable: unauthenticated VNC server at 127.0.0.1:${port}; require a password-protected VncAuth server, then retry`
      : `unavailable: ${security} security is not supported; configure a VncAuth server and desktop.host.passwordFile, then retry`;
  return {
    status: { enabled: true, state: "unavailable", port, security },
    detail,
    unavailableReason: "unsupported",
  };
}

/** Creates the host acquisition hook consumed by the source-agnostic desktop registry. */
export function createHostDesktopSource(params: {
  config: DesktopHostConfig;
  platform?: NodeJS.Platform;
  managedDesktop?: ManagedLinuxDesktop;
  probeRfb?: typeof probeRfbServer;
}) {
  const port = params.config.port ?? DEFAULT_HOST_DESKTOP_PORT;
  const platform = params.platform ?? process.platform;
  const probeRfb = params.probeRfb ?? probeRfbServer;
  const managedDesktop =
    params.managedDesktop ??
    (params.config.managed === true && platform === "linux"
      ? createManagedLinuxDesktop()
      : undefined);
  let selectedManagedDesktop = false;

  const acquireAttached = async (
    probe: Extract<RfbProbeResult, { kind: "rfb" }>,
  ): Promise<HostDesktopAcquireResult> => {
    const security = classifyRfbSecurity(probe.securityTypes);
    if (security === "none") {
      throw new Error(
        `refusing unauthenticated VNC server on 127.0.0.1:${port}; require a password-protected VncAuth server, then retry`,
      );
    }
    if (security === "unsupported") {
      const name = probe.securityTypes.includes(19) ? "VeNCrypt" : "the offered VNC security";
      throw new Error(
        `${name} is not supported; configure a VncAuth server and desktop.host.passwordFile, then retry`,
      );
    }

    let vncPassword: string | undefined;
    if (params.config.passwordFile) {
      try {
        vncPassword = (await fs.readFile(params.config.passwordFile, "utf8")).replace(
          /[\r\n]+$/u,
          "",
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(
          `could not read desktop.host.passwordFile ${params.config.passwordFile}: ${reason}; fix the absolute path or remove desktop.host.passwordFile so the UI can prompt`,
          { cause: error },
        );
      }
      if (!vncPassword) {
        throw new Error(
          "desktop.host.passwordFile is empty; write the VNC password or remove desktop.host.passwordFile so the UI can prompt",
        );
      }
      registerSecretValueForRedaction(vncPassword);
    }
    return {
      attachment: { kind: "tcp", host: "127.0.0.1", port },
      auth: security,
      ...(vncPassword ? { vncPassword } : {}),
    };
  };

  const acquire = async (assertCurrent?: () => void): Promise<HostDesktopAcquireResult> => {
    assertCurrent?.();
    selectedManagedDesktop = false;
    const probe = await probeRfb({
      host: "127.0.0.1",
      port,
      timeoutMs: HOST_DESKTOP_PROBE_TIMEOUT_MS,
    });
    assertCurrent?.();
    if (probe.kind === "unreachable" || probe.kind === "timeout") {
      if (params.config.port === undefined && params.config.managed === true) {
        if (platform !== "linux") {
          throw new Error(managedPlatformError(platform));
        }
        if (!managedDesktop) {
          throw new Error("managed Linux desktop lifecycle is unavailable; retry");
        }
        const acquired = await managedDesktop.acquire();
        assertCurrent?.();
        selectedManagedDesktop = true;
        return acquired;
      }
      throw new Error(unavailableError(port, platform));
    }
    if (probe.kind === "not-rfb") {
      throw new Error(nonRfbError(port));
    }
    return await acquireAttached(probe);
  };

  return {
    acquire,
    acquireComputer: async (computerParams: { onStop(): Promise<void> }) => {
      if (!selectedManagedDesktop || !managedDesktop) {
        throw new Error(
          "COMPUTER_HOST_UNAVAILABLE: the selected host desktop is an external VNC server; its local computer session is unknown",
        );
      }
      return await managedDesktop.acquireComputer(computerParams);
    },
    teardown: managedDesktop
      ? () => {
          selectedManagedDesktop = false;
          return managedDesktop.stop();
        }
      : undefined,
    inspect: () =>
      inspectHostDesktop({
        config: params.config,
        platform,
        managedDesktop,
        probeRfb,
      }),
  };
}

export type HostDesktopService = {
  observe(params: {
    control: boolean;
    requester?: DesktopObserveRequester;
    credentials?: { username?: string; password?: string };
  }): Promise<{
    transport: "rfb";
    wsPath: string;
    expiresAtMs: number;
    control: boolean;
    auth: "vnc-password" | "ard-account";
    vncPassword?: string;
  }>;
  acquireComputer(params: { onStop(): Promise<void> }): Promise<DesktopComputerLease>;
  status(): Promise<HostDesktopStatus>;
  reconcileRuntimePolicy(): Promise<void>;
};

/** Combines host acquisition, registry ownership, and observer-token minting. */
export function createHostDesktopService(params: {
  getConfig: () => DesktopHostConfig | undefined;
  registry: DesktopSessionRegistry;
  platform?: NodeJS.Platform;
  managedDesktop?: ManagedLinuxDesktop;
}): HostDesktopService {
  const platform = params.platform ?? process.platform;
  type HostDesktopRuntime = {
    config: DesktopHostConfig;
    ownerEpoch: number;
    controller: AbortController;
    source: ReturnType<typeof createHostDesktopSource>;
    stopping?: Promise<void>;
  };
  let current: HostDesktopRuntime | undefined;
  let nextOwnerEpoch = 0;
  const isCurrent = (runtime: HostDesktopRuntime) => {
    const config = params.getConfig();
    return (
      current === runtime &&
      !runtime.controller.signal.aborted &&
      config?.enabled === true &&
      config.managed === runtime.config.managed &&
      config.port === runtime.config.port &&
      config.passwordFile === runtime.config.passwordFile
    );
  };
  const assertCurrent = (runtime: HostDesktopRuntime) => {
    if (!isCurrent(runtime)) {
      throw new Error("gateway host desktop configuration changed; retry");
    }
  };
  const reconcileRuntimePolicy = async () => {
    const runtime = current;
    if (!runtime || isCurrent(runtime)) {
      return;
    }
    // Revoke tickets before waiting for acquisition and managed-process cleanup.
    runtime.controller.abort();
    if (!runtime.stopping) {
      runtime.stopping = params.registry.stop("host", runtime.ownerEpoch).then(
        () => {
          if (current === runtime) {
            current = undefined;
          }
        },
        (error: unknown) => {
          runtime.stopping = undefined;
          throw error;
        },
      );
    }
    await runtime.stopping;
  };
  const resolveRuntime = async () => {
    await reconcileRuntimePolicy();
    const config = params.getConfig();
    if (config?.enabled !== true) {
      return undefined;
    }
    if (!current) {
      const ownerEpoch = nextOwnerEpoch++;
      const managedDesktop =
        params.managedDesktop ??
        (config.managed === true && platform === "linux"
          ? createManagedLinuxDesktop({
              onFailed: () => {
                void params.registry.stop("host", ownerEpoch);
              },
            })
          : undefined);
      const snapshot = { ...config };
      current = {
        config: snapshot,
        ownerEpoch,
        controller: new AbortController(),
        source: createHostDesktopSource({
          config: snapshot,
          platform,
          ...(managedDesktop ? { managedDesktop } : {}),
        }),
      };
    }
    return current;
  };
  const acquire = async () => {
    const runtime = await resolveRuntime();
    if (!runtime) {
      throw new Error(
        "gateway host desktop is disabled; enable the Desktop lab (config: desktop.host.enabled=true)",
      );
    }
    assertCurrent(runtime);
    const acquired = await params.registry.acquire({
      sourceKey: "host",
      ownerEpoch: runtime.ownerEpoch,
      start: () => runtime.source.acquire(() => assertCurrent(runtime)),
      ...(runtime.source.teardown ? { teardown: runtime.source.teardown } : {}),
    });
    assertCurrent(runtime);
    return { acquired, runtime };
  };
  return {
    async observe(observeParams) {
      const { acquired, runtime } = await acquire();
      assertCurrent(runtime);
      const auth = acquired.auth;
      if (!auth) {
        throw new Error("gateway host desktop authentication state is unavailable; retry observe");
      }
      let preauth:
        | {
            auth: "ard-account";
            credentials: { username: string; password: string };
          }
        | undefined;
      if (auth === "ard-account") {
        const username = observeParams.credentials?.username?.trim() ?? "";
        const password = observeParams.credentials?.password ?? "";
        if (!username || !password) {
          throw new HostDesktopCredentialsRequiredError();
        }
        registerSecretValueForRedaction(password);
        preauth = { auth: "ard-account", credentials: { username, password } };
      }
      const minted = mintDesktopObserverToken({
        sourceKey: "host",
        ownerEpoch: runtime.ownerEpoch,
        control: observeParams.control,
        requester: {
          ...observeParams.requester,
          signal: observeParams.requester?.signal
            ? AbortSignal.any([runtime.controller.signal, observeParams.requester.signal])
            : runtime.controller.signal,
          isCurrent: () => isCurrent(runtime) && observeParams.requester?.isCurrent() !== false,
        },
        attachment: acquired.attachment,
        ...(preauth ? { preauth } : {}),
      });
      return {
        transport: "rfb",
        wsPath: `/desktop/observe?token=${minted.token}`,
        expiresAtMs: minted.expiresAtMs,
        control: observeParams.control,
        auth,
        ...(auth === "vnc-password" && acquired.vncPassword
          ? { vncPassword: acquired.vncPassword }
          : {}),
      };
    },
    async acquireComputer(computerParams) {
      const { runtime } = await acquire();
      assertCurrent(runtime);
      const activity = params.registry.retainActivity("host", runtime.ownerEpoch);
      if (!activity) {
        throw new Error("COMPUTER_HOST_UNAVAILABLE: the host desktop stopped during acquisition");
      }
      try {
        const computer = await runtime.source.acquireComputer(computerParams);
        if (!isCurrent(runtime) || !activity.isCurrent() || !computer.isCurrent()) {
          computer.release();
          throw new Error("COMPUTER_HOST_UNAVAILABLE: the host desktop stopped during acquisition");
        }
        return {
          env: computer.env,
          isCurrent: () => isCurrent(runtime) && activity.isCurrent() && computer.isCurrent(),
          release() {
            computer.release();
            activity.release();
          },
        };
      } catch (error) {
        activity.release();
        throw error;
      }
    },
    async status() {
      for (;;) {
        const runtime = await resolveRuntime();
        if (!runtime) {
          return (await inspectHostDesktop({ config: params.getConfig(), platform })).status;
        }
        const inspection = await runtime.source.inspect();
        if (isCurrent(runtime)) {
          return inspection.status;
        }
      }
    },
    reconcileRuntimePolicy,
  };
}
