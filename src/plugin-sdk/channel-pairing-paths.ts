/** @deprecated Compatibility helper for doctor/plugin migrations of the retired JSON store. */
import os from "node:os";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { safeAccountKey, safeChannelKey } from "../pairing/pairing-store-keys.js";
import type { PairingChannel } from "../pairing/pairing-store.types.js";

export function resolveChannelAllowFromPath(
  channel: PairingChannel,
  env: NodeJS.ProcessEnv = process.env,
  accountId?: string,
): string {
  const stateDir = resolveStateDir(env, () => resolveRequiredHomeDir(env, os.homedir));
  const credentialsDir = resolveOAuthDir(env, stateDir);
  const normalizedAccountId = normalizeOptionalString(accountId);
  const suffix = normalizedAccountId ? `-${safeAccountKey(normalizedAccountId)}` : "";
  return path.join(credentialsDir, `${safeChannelKey(channel)}${suffix}-allowFrom.json`);
}
