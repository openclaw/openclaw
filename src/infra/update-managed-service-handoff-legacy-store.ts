import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveServiceManagerEnv } from "../daemon/service-process-env.js";
import { resolveServiceTmpDir } from "../daemon/service-tmp-dir.js";
import {
  prepareManagedHandoffLeaseStore,
  resolveManagedUpdateLeaseDatabasePath,
} from "./update-managed-service-handoff-lease.js";

/** Earlier macOS Gateways kept leases under their state's TMPDIR; repair still reads it. */
export function resolveLegacyGatewayManagedUpdateLeaseDatabasePath(): string | undefined {
  const uid = process.getuid?.();
  const legacy = path.join(
    resolveServiceTmpDir(process.env, "darwin"),
    uid === undefined ? "openclaw" : `openclaw-${uid}`,
    "managed-update-handoffs.sqlite",
  );
  return process.platform === "darwin" && legacy !== resolveManagedUpdateLeaseDatabasePath()
    ? legacy
    : undefined;
}

/**
 * Hold the installation in an earlier Gateway's store while admission proceeds, so
 * that store's own owner decides whether its custody has settled. Release after
 * the shared store has admitted or refused this update.
 */
export async function fenceLegacyGatewayCustody(
  key: string,
  databasePath: string | undefined,
): Promise<{ refusal: string } | { release: () => void }> {
  if (!databasePath || !fs.existsSync(databasePath)) {
    return { release: () => {} };
  }
  const store = await prepareManagedHandoffLeaseStore({
    databasePath,
    serviceManagerEnv: resolveServiceManagerEnv(),
  });
  const acquired = store.acquire(key, randomUUID(), { kind: "update" });
  if (acquired.kind !== "acquired") {
    return {
      refusal: `Another update executor owns this installation in an earlier Gateway's handoff store (${databasePath}). If that update has exited, run ${formatCliCommand("openclaw update repair")} to settle it.`,
    };
  }
  return {
    release: () => {
      if (!store.release(acquired.lease)) {
        throw new Error(`Could not release the earlier Gateway handoff fence in ${databasePath}.`);
      }
    },
  };
}

/** Refuse while an earlier Gateway's store holds the installation; otherwise release at once. */
export async function assertLegacyGatewayCustodySettled(
  key: string,
  databasePath: string | undefined,
): Promise<void> {
  const fence = await fenceLegacyGatewayCustody(key, databasePath);
  if ("refusal" in fence) {
    throw new Error(fence.refusal);
  }
  fence.release();
}
