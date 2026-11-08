import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { formatErrorMessage } from "../infra/errors.js";
import { withClawPackageLifecycleLease } from "../state/claw-package-lifecycle-lease.js";

type ClawHubInstallRecord = {
  source?: string;
  clawhubPackage?: string;
  spec?: string;
  resolvedSpec?: string;
};

export function resolveRecordedClawHubPackage(record: ClawHubInstallRecord): string | undefined {
  if (record.source !== "clawhub") {
    return undefined;
  }
  return (
    record.clawhubPackage ??
    parseClawHubPluginSpec(record.spec ?? "")?.name ??
    parseClawHubPluginSpec(record.resolvedSpec ?? "")?.name
  );
}

export async function runPluginUpdateWithClawHubLease<T>(params: {
  pluginId: string;
  clawhubPackage?: string;
  dryRun: boolean;
  beforePersistentEffect?: () => void;
  run: () => Promise<T>;
}): Promise<T | { kind: "exception"; message: string; error: unknown }> {
  try {
    if (!params.clawhubPackage || params.dryRun) {
      return await params.run();
    }
    return await withClawPackageLifecycleLease(
      { kind: "plugin", source: "clawhub", ref: params.clawhubPackage },
      async () => {
        params.beforePersistentEffect?.();
        return await params.run();
      },
    );
  } catch (error) {
    // Normalize only after the lease settles, so cleanup retains the initiating failure.
    return {
      kind: "exception",
      message: `Failed to ${params.dryRun ? "check" : "update"} ${params.pluginId}: ${formatErrorMessage(error)}`,
      error,
    };
  }
}
