import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("onboard");

/** Backoff before retrying a locked staging removal; injected in tests. */
export const SETUP_STAGING_REMOVE_RETRY_DELAYS_MS: readonly number[] = [100, 300, 600];

const RETRYABLE_REMOVE_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

/**
 * Windows keeps SQLite handles mapped briefly past close, so removing the staging
 * directory can fail with EBUSY/EPERM even after the closers ran. Cleanup is
 * best-effort: the directory lives in the OS temp directory, while throwing here
 * would abort onboarding and leave a half-configured install (#172368).
 */
export async function removeSetupStagingRoot(
  stagingRoot: string,
  retryDelaysMs: readonly number[] = SETUP_STAGING_REMOVE_RETRY_DELAYS_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rm(stagingRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
      const retryDelayMs = retryDelaysMs[attempt];
      if (retryDelayMs !== undefined && code !== undefined && RETRYABLE_REMOVE_CODES.has(code)) {
        await new Promise((resolve) => {
          setTimeout(resolve, retryDelayMs);
        });
        continue;
      }
      log.warn(
        `could not remove the setup credential staging directory ${stagingRoot}: ${
          error instanceof Error ? error.message : String(error)
        }; remove it manually if it persists`,
      );
      return;
    }
  }
}
