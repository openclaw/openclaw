import {
  getGatewayRuntimeSnapshotStatus,
  pruneGatewayRuntimeSnapshots,
  rollbackGatewayRuntimeSnapshot,
  type GatewayRuntimeSnapshotPruneResult,
  type GatewayRuntimeSnapshotStatus,
} from "../../daemon/gateway-runtime-snapshot.js";
import { defaultRuntime } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import { formatCliCommand } from "../command-format.js";
import { createCliStatusTextStyles } from "./shared.js";

export type GatewaySnapshotStatusOptions = {
  json?: boolean;
};

export type GatewaySnapshotPruneOptions = {
  json?: boolean;
  keep?: string;
};

export type GatewaySnapshotRollbackOptions = {
  json?: boolean;
  releaseId: string;
};

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const rounded = unitIndex === 0 || value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${units[unitIndex]}`;
}

function printSnapshotStatus(status: GatewayRuntimeSnapshotStatus) {
  const { label, infoText, okText, warnText } = createCliStatusTextStyles();
  defaultRuntime.log(`${label("Gateway snapshots:")} ${infoText(String(status.releaseCount))}`);
  defaultRuntime.log(`${label("Latest:")} ${infoText(status.latestReleaseId ?? "none")}`);
  defaultRuntime.log(`${label("Total size:")} ${infoText(formatBytes(status.totalBytes))}`);
  defaultRuntime.log(`${label("Snapshot dir:")} ${infoText(shortenHomePath(status.snapshotDir))}`);
  if (status.releases.length === 0) {
    defaultRuntime.log(warnText("No promoted Gateway runtime snapshots found."));
    return;
  }
  defaultRuntime.log("");
  for (const release of status.releases) {
    const markers = [
      release.latest ? okText("latest") : null,
      release.protected ? okText("protected") : null,
      release.usable ? null : warnText("incomplete"),
    ].filter(Boolean);
    const markerText = markers.length ? ` (${markers.join(", ")})` : "";
    defaultRuntime.log(
      `${release.releaseId}${markerText} · ${formatBytes(release.sizeBytes ?? 0)} · ${shortenHomePath(release.root)}`,
    );
  }
}

function printPruneResult(result: GatewayRuntimeSnapshotPruneResult) {
  const { label, infoText, okText, warnText } = createCliStatusTextStyles();
  if (result.skipped) {
    defaultRuntime.log(`${label("Prune:")} ${warnText(`skipped (${result.skipped})`)}`);
    return;
  }
  defaultRuntime.log(`${label("Pruned:")} ${okText(String(result.pruned.length))}`);
  defaultRuntime.log(`${label("Retained:")} ${infoText(String(result.retained.length))}`);
  defaultRuntime.log(`${label("Keep count:")} ${infoText(String(result.keepCount ?? "n/a"))}`);
  for (const release of result.pruned) {
    defaultRuntime.log(`- ${release.releaseId} · ${shortenHomePath(release.root)}`);
  }
}

function printRollbackResult(result: GatewaySnapshotRollbackOptions) {
  const { label, infoText, warnText } = createCliStatusTextStyles();
  defaultRuntime.log(`${label("Rolled back latest snapshot:")} ${infoText(result.releaseId)}`);
  defaultRuntime.log(
    warnText(`Restart the Gateway to activate it: ${formatCliCommand("openclaw gateway restart")}`),
  );
}

export async function runGatewaySnapshotStatus(opts: GatewaySnapshotStatusOptions) {
  const status = getGatewayRuntimeSnapshotStatus({ includeSize: true });
  if (opts.json) {
    defaultRuntime.writeJson(status);
    return;
  }
  printSnapshotStatus(status);
}

export async function runGatewaySnapshotPrune(opts: GatewaySnapshotPruneOptions) {
  const result = pruneGatewayRuntimeSnapshots({ keepCount: opts.keep });
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  printPruneResult(result);
}

export async function runGatewaySnapshotRollback(opts: GatewaySnapshotRollbackOptions) {
  const result = rollbackGatewayRuntimeSnapshot({ releaseId: opts.releaseId });
  if (opts.json) {
    defaultRuntime.writeJson(result);
    return;
  }
  printRollbackResult({ ...opts, releaseId: result.releaseId });
}
