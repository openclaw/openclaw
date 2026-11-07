import { isDeepStrictEqual } from "node:util";
import {
  applyChannelAccountDeleteFollowUp,
  type ChannelAccountDeleteFollowUp,
} from "../../channels/plugins/account-delete-follow-up.js";
import { getConfigValueAtPath } from "../../config/config-paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { transformConfigWithPendingPluginInstalls } from "../../plugins/install-record-commit.js";
import type { RuntimeEnv } from "../../runtime.js";

/**
 * Writes the follow-up to the config file the delete was written to. Nothing is written unless the
 * delete is still in place and every value it changed outside `channels` is still what it saw.
 */
async function persistChannelAccountDeleteFollowUp(
  followUp: ChannelAccountDeleteFollowUp,
  configPath: string,
): Promise<void> {
  await transformConfigWithPendingPluginInstalls({
    writeOptions: {
      ownedConfigPathForWrite: configPath,
      // The delete itself passed every writer guard. This write applies only what that delete
      // changed outside `channels`, which can be most of a small config.
      allowConfigSizeDrop: true,
    },
    transform: (current, { snapshot }) => {
      for (const { path, value } of [...followUp.deleted, ...followUp.previous]) {
        if (!isDeepStrictEqual(getConfigValueAtPath(current, path), value)) {
          throw new Error(`${path.join(".")} changed after the delete was prepared`);
        }
      }
      const nextConfig = structuredClone(current);
      applyChannelAccountDeleteFollowUp(nextConfig, followUp, snapshot);
      return { nextConfig };
    },
  });
}

/**
 * Persists a follow-up and applies it to the caller's in-memory configs. A failed follow-up leaves
 * the committed delete in place and reports what to check instead of failing the command.
 */
export async function persistAccountDeleteFollowUp(
  followUp: ChannelAccountDeleteFollowUp,
  configPath: string,
  runtime: Pick<RuntimeEnv, "error">,
  configs: readonly OpenClawConfig[] = [],
): Promise<boolean> {
  try {
    await persistChannelAccountDeleteFollowUp(followUp, configPath);
  } catch (error) {
    const paths = followUp.paths.join(", ");
    runtime.error(
      `Could not update ${paths} after deleting the account. Check ${paths} and finish the cleanup by hand if it is still needed. Reason: ${formatErrorMessage(error)}`,
    );
    return false;
  }
  for (const config of configs) {
    applyChannelAccountDeleteFollowUp(config, followUp);
  }
  return true;
}
