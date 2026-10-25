import path from "node:path";
import { root } from "../infra/fs-safe.js";
import { captureConfigHealthStateStore } from "./io.health-state.js";
import {
  commitConfigRecoveryFile,
  createConfigRecoverySourceGuard,
} from "./io.observe-recovery-effects.js";
import type { ObserveRecoveryDeps } from "./io.observe-recovery.js";
import { createConfigHealthFingerprint, readConfigHealthEntry } from "./io.observe-state.js";
import { resolveConfigObserveSuspiciousReasons } from "./io.observe-suspicious.js";
import { chmodConfigBestEffort } from "./io.write-safety.js";
import { resolveIsConfigReadOnly } from "./paths.js";
import { collectPollutedSecretPlaceholders } from "./recovery-policy.js";
import type { ConfigFileSnapshot } from "./types.openclaw.js";

/** True reports committed file work; health metadata remains best-effort. */
export async function promoteConfigSnapshotToLastKnownGoodCore(params: {
  deps: ObserveRecoveryDeps;
  snapshot: ConfigFileSnapshot;
  logger?: Pick<typeof console, "warn">;
}): Promise<boolean> {
  const { deps, snapshot } = params;
  if (resolveIsConfigReadOnly(deps.env)) {
    return false;
  }
  if (!snapshot.exists || !snapshot.valid || typeof snapshot.raw !== "string") {
    return false;
  }
  const polluted = collectPollutedSecretPlaceholders(snapshot.parsed);
  if (polluted.length > 0) {
    params.logger?.warn(
      `Config last-known-good promotion skipped: redacted secret placeholder at ${polluted[0]}`,
    );
    return false;
  }
  const health = captureConfigHealthStateStore(deps, snapshot.path);
  const healthSnapshot = await health.read();
  const stat = await deps.fs.promises.stat(snapshot.path).catch(() => null);
  const now = new Date().toISOString();
  const current = createConfigHealthFingerprint({
    raw: snapshot.raw,
    parsed: snapshot.parsed,
    resolved: snapshot.resolved,
    stat,
    observedAt: now,
  });
  const lastGoodPath = `${snapshot.path}.last-good`;
  health.assertCurrent();
  const entry = readConfigHealthEntry(healthSnapshot.state, snapshot.path);
  const suspiciousReasons = resolveConfigObserveSuspiciousReasons({
    hash: current.hash,
    lastObservedSuspiciousSignature: entry.lastObservedSuspiciousSignature,
    bytes: current.bytes,
    hasMeta: current.hasMeta,
    gatewayMode: current.gatewayMode,
    parsed: snapshot.parsed,
    lastKnownGood: entry.lastKnownGood,
  });
  if (suspiciousReasons.length > 0) {
    params.logger?.warn(
      `Config last-known-good promotion skipped: ${snapshot.path} (${suspiciousReasons.join(", ")})`,
    );
    return false;
  }
  const raw = snapshot.raw;
  const assertUnchanged = createConfigRecoverySourceGuard(deps, [[snapshot.path, raw, stat]]);
  await commitConfigRecoveryFile({
    health,
    beforeCommit: assertUnchanged,
    write: async (assertCurrent) => {
      const directory = await root(path.dirname(lastGoodPath));
      await directory.write(path.basename(lastGoodPath), raw, {
        mkdir: false,
        mode: 0o600,
        durable: false,
        encoding: "utf8",
        overwrite: true,
        assertBeforeMutation: assertCurrent,
      });
    },
  });
  await chmodConfigBestEffort({
    deps,
    configPath: lastGoodPath,
    context: "last-known-good promotion",
  });
  await health.updateAfterFileCommit(
    {
      lastKnownGood: current,
      lastPromotedGood: current,
      lastObservedSuspiciousSignature: null,
    },
    healthSnapshot,
  );
  return true;
}
