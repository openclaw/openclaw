import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { markClawPackageIndependentlyOwned } from "../state/claw-package-adoption.js";
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
        markClawPackageIndependentlyOwned({
          kind: "plugin",
          source: "clawhub",
          ref: params.clawhubPackage!,
        });
        return await params.run();
      },
      { required: true },
    );
  } catch (error) {
    return {
      kind: "exception",
      message: `Failed to update ${params.pluginId}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    };
  }
}
