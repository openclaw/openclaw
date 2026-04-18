import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import { readGatewayServiceState, type GatewayService } from "../daemon/service.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";

export type ServiceStatusSummary = {
  label: string;
  installed: boolean | null;
  loaded: boolean;
  managedByOpenClaw: boolean;
  externallyManaged: boolean;
  loadedText: string;
  runtime: GatewayServiceRuntime | undefined;
  packageRoot?: string | null;
  sourcePath?: string | null;
};

function isCommandPathCandidate(value: string): boolean {
  return /[/\\]/.test(value) && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

async function resolveServicePackageRoot(
  command: Awaited<ReturnType<typeof readGatewayServiceState>>["command"],
): Promise<string | null> {
  if (!command) {
    return null;
  }
  const candidates = command.programArguments.filter(isCommandPathCandidate);
  for (const candidate of candidates) {
    const root = await resolveOpenClawPackageRoot({ argv1: candidate }).catch(() => null);
    if (root) {
      return root;
    }
  }
  if (command.workingDirectory) {
    return (
      (await resolveOpenClawPackageRoot({ cwd: command.workingDirectory }).catch(() => null)) ??
      null
    );
  }
  return null;
}

export async function readServiceStatusSummary(
  service: GatewayService,
  fallbackLabel: string,
): Promise<ServiceStatusSummary> {
  try {
    const state = await readGatewayServiceState(service, { env: process.env });
    const managedByOpenClaw = state.installed;
    const externallyManaged = !managedByOpenClaw && state.running;
    const installed = managedByOpenClaw || externallyManaged;
    const loadedText = externallyManaged
      ? "running (externally managed)"
      : state.loaded
        ? service.loadedText
        : service.notLoadedText;
    const packageRoot = await resolveServicePackageRoot(state.command).catch(() => null);
    return {
      label: service.label,
      installed,
      loaded: state.loaded,
      managedByOpenClaw,
      externallyManaged,
      loadedText,
      runtime: state.runtime,
      packageRoot,
      sourcePath: state.command?.sourcePath ?? null,
    };
  } catch {
    return {
      label: fallbackLabel,
      installed: null,
      loaded: false,
      managedByOpenClaw: false,
      externallyManaged: false,
      loadedText: "unknown",
      runtime: undefined,
      packageRoot: null,
      sourcePath: null,
    };
  }
}
