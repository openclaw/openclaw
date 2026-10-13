import { currentGatewayServiceRebindReceipt } from "../../daemon/service-rebind.js";
import type { GatewayServiceDefinitionBackupReceipt } from "../../daemon/service-stage.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  isSystemdUnavailableDetail,
  renderSystemdUnavailableHints,
} from "../../daemon/systemd-hints.js";
import { classifySystemdUnavailableDetail } from "../../daemon/systemd-unavailable.js";
import { isWSL } from "../../infra/wsl.js";
import { defaultRuntime } from "../../runtime.js";
import { createNullWriter } from "../../shared/null-writer.js";

type DaemonAction = "install" | "uninstall" | "start" | "stop" | "restart";

/** Stable hint category for machine-readable daemon command output. */
type DaemonHintKind =
  | "install"
  | "container-restart"
  | "container-foreground"
  | "systemd-unavailable"
  | "systemd-headless"
  | "wsl-systemd"
  | "generic";

type DaemonHintItem = {
  kind: DaemonHintKind;
  text: string;
};

type DaemonActionResponse = {
  ok: boolean;
  action: DaemonAction;
  result?: string;
  message?: string;
  error?: string;
  hints?: string[];
  hintItems?: DaemonHintItem[];
  warnings?: string[];
  definitionBackup?: GatewayServiceDefinitionBackupReceipt;
  service?: ReturnType<typeof buildDaemonServiceSnapshot>;
};

const DAEMON_HINT_PREFIXES: readonly (readonly [string, DaemonHintKind])[] = [
  ["Service not installed. Run:", "install"],
  ["Restart the container or the service that manages it for ", "container-restart"],
  ["systemd user services are unavailable;", "systemd-unavailable"],
  ["On a headless server (SSH/no desktop session):", "systemd-headless"],
  ["Also check that XDG_RUNTIME_DIR is set:", "systemd-headless"],
  [
    "If you're in a container, run the gateway in the foreground instead of",
    "container-foreground",
  ],
  ["WSL2 needs systemd enabled:", "wsl-systemd"],
  ["Then run: wsl --shutdown", "wsl-systemd"],
  ["Verify: systemctl --user status", "wsl-systemd"],
];

function classifyDaemonHintText(text: string): DaemonHintKind {
  if (/\b(gateway|node) install\b/u.test(text)) {
    return "install";
  }
  return DAEMON_HINT_PREFIXES.find(([prefix]) => text.startsWith(prefix))?.[1] ?? "generic";
}

export function buildDaemonServiceSnapshot(service: GatewayService, loaded: boolean) {
  return {
    label: service.label,
    loaded,
    loadedText: service.loadedText,
    notLoadedText: service.notLoadedText,
  };
}

type DaemonEmit = (payload: Omit<DaemonActionResponse, "action">) => void;

export function createDaemonActionContext(params: {
  action: DaemonAction;
  json: boolean;
  definitionBackup?: () => GatewayServiceDefinitionBackupReceipt | undefined;
}) {
  const warnings: string[] = [];
  const stdout = params.json ? createNullWriter() : process.stdout;
  const emit = (payload: Omit<DaemonActionResponse, "action">) => {
    if (!params.json) {
      return;
    }
    const definitionBackup = params.definitionBackup?.();
    const payloadWithContext: DaemonActionResponse = {
      action: params.action,
      ...(definitionBackup ? { definitionBackup } : {}),
      ...payload,
      hintItems:
        payload.hintItems ??
        (payload.hints?.length
          ? payload.hints.map((text) => ({ kind: classifyDaemonHintText(text), text }))
          : undefined),
      warnings: payload.warnings ?? (warnings.length ? warnings : undefined),
    };
    const rebind = currentGatewayServiceRebindReceipt();
    defaultRuntime.writeJson({ ...payloadWithContext, ...(rebind ? { rebind } : {}) });
  };
  // Message-bearing successes opt into text; emit remains JSON-only.
  const emitMessage: DaemonEmit = (payload) => {
    emit(payload);
    if (!params.json && payload.message) {
      defaultRuntime.log(payload.message);
    }
  };
  const fail = (
    message: string,
    hints?: string[],
    result?: "restart-health-failed" | "still-starting",
  ) => {
    if (params.json) {
      emit({
        ok: false,
        error: message,
        hints,
        ...(result ? { result } : {}),
      });
    } else {
      defaultRuntime.error(message);
      if (hints?.length) {
        for (const hint of hints) {
          defaultRuntime.log(`Tip: ${hint}`);
        }
      }
    }
    defaultRuntime.exit(result === "still-starting" ? 2 : 1);
  };

  return { stdout, warnings, emit, emitMessage, fail };
}

async function buildInstallFailureHints(error: unknown): Promise<string[] | undefined> {
  const detail = String(error);
  if (process.platform !== "linux" || !isSystemdUnavailableDetail(detail)) {
    return undefined;
  }
  return renderSystemdUnavailableHints({
    wsl: await isWSL(),
    kind: classifySystemdUnavailableDetail(detail),
  });
}

export async function installDaemonServiceAndEmit(params: {
  serviceNoun: string;
  service: GatewayService;
  warnings: string[];
  emit: (payload: Omit<DaemonActionResponse, "action">) => void;
  fail: (message: string, hints?: string[]) => void;
  install: () => Promise<void>;
  /** Distinguishes successful registration from application readiness. */
  successMessage?: string;
  /**
   * Runs only after the service has been written AND verified as loaded, but
   * before the success payload is emitted. Use this for post-success
   * diagnostics (e.g. linger warnings) so they never accompany a failed
   * install or a verification failure. Throwing here surfaces as a failure.
   */
  onVerified?: () => Promise<void>;
}) {
  let installed: boolean;
  let phase = "install";
  try {
    await params.install();
    phase = "install verification";
    installed = await params.service.isLoaded({ env: process.env });
  } catch (err) {
    params.fail(
      `${params.serviceNoun} ${phase} failed: ${String(err)}`,
      await buildInstallFailureHints(err),
    );
    return;
  }
  if (!installed) {
    params.fail(
      `${params.serviceNoun} install verification failed: service is not ${params.service.loadedText}.`,
    );
    return;
  }
  if (params.onVerified) {
    try {
      await params.onVerified();
    } catch (err) {
      params.fail(`${params.serviceNoun} post-install check failed: ${String(err)}`);
      return;
    }
  }
  params.emit({
    ok: true,
    result: "installed",
    ...(params.successMessage ? { message: params.successMessage } : {}),
    service: buildDaemonServiceSnapshot(params.service, installed),
    warnings: params.warnings.length ? params.warnings : undefined,
  });
}
