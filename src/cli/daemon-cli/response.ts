import { Writable } from "node:stream";
import type { GatewayService } from "../../daemon/service.js";
import { defaultRuntime } from "../../runtime.js";

export type DaemonAction = "install" | "uninstall" | "start" | "stop" | "restart";

export type DaemonActionResponse = {
  ok: boolean;
  action: DaemonAction;
  result?: string;
  message?: string;
  error?: string;
  hints?: string[];
  warnings?: string[];
  service?: {
    label: string;
    loaded: boolean;
    loadedText: string;
    notLoadedText: string;
  };
};

export function emitDaemonActionJson(payload: DaemonActionResponse) {
  defaultRuntime.log(JSON.stringify(payload, null, 2));
}

export function buildDaemonServiceSnapshot(service: GatewayService, loaded: boolean) {
  return {
    label: service.label,
    loaded,
    loadedText: service.loadedText,
    notLoadedText: service.notLoadedText,
  };
}

export function createNullWriter(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

export function createDaemonActionContext(params: { action: DaemonAction; json: boolean }): {
  stdout: Writable;
  warnings: string[];
  emit: (payload: Omit<DaemonActionResponse, "action">) => void;
  fail: (message: string, hints?: string[]) => void;
} {
  const warnings: string[] = [];
  const stdout = params.json ? createNullWriter() : process.stdout;
  const emit = (payload: Omit<DaemonActionResponse, "action">) => {
    if (!params.json) {
      return;
    }
    emitDaemonActionJson({
      action: params.action,
      ...payload,
      warnings: payload.warnings ?? (warnings.length ? warnings : undefined),
    });
  };
  const fail = (message: string, hints?: string[]) => {
    if (params.json) {
      emit({
        ok: false,
        error: message,
        hints,
      });
    } else {
      defaultRuntime.error(message);
      if (hints?.length) {
        for (const hint of hints) {
          defaultRuntime.log(`Tip: ${hint}`);
        }
      }
    }
    defaultRuntime.exit(1);
  };

  return { stdout, warnings, emit, fail };
}

export async function installDaemonServiceAndEmit(params: {
  serviceNoun: string;
  service: GatewayService;
  warnings: string[];
  emit: (payload: Omit<DaemonActionResponse, "action">) => void;
  fail: (message: string, hints?: string[]) => void;
  install: () => Promise<void>;
}) {
  try {
    await params.install();
  } catch (err) {
    params.fail(`${params.serviceNoun} install failed: ${String(err)}`);
    return;
  }

  let installed = true;
  try {
    installed = await params.service.isLoaded({ env: process.env });
  } catch {
    installed = true;
  }
  params.emit({
    ok: true,
    result: "installed",
    service: buildDaemonServiceSnapshot(params.service, installed),
    warnings: params.warnings.length ? params.warnings : undefined,
  });
}
