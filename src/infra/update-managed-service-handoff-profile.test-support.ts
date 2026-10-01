import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { linkUserChannelIdentity } from "../state/user-channel-identities.js";
import { ensureProfileForEmail, setUserProfileRole } from "../state/user-profiles.js";
import { hasErrnoCode } from "./errno.js";
import type { ManagedServiceBoundaryOptions } from "./update-managed-service-handoff-boundary-contract.test-support.js";
import { isManagedServiceInspectionCommand } from "./update-managed-service-handoff-lifecycle.test-support.js";

export async function prepareManagedServiceProfileRequester(
  options: ManagedServiceBoundaryOptions | undefined,
  env: NodeJS.ProcessEnv & { OPENCLAW_CONFIG_PATH: string },
) {
  if (!options?.profileRequester) {
    return options;
  }
  const profile = ensureProfileForEmail("admin@example.test", { env });
  setUserProfileRole(profile.id, "admin", { env });
  linkUserChannelIdentity(
    profile.id,
    {
      channelId: "slack",
      accountId: "primary",
      senderId: "owner",
    },
    { env },
  );
  const profileConfig: OpenClawConfig = {
    gateway: {
      roles: {
        default: "admin",
        definitions: {
          admin: {
            scopes: ["operator.admin"],
            agents: "*",
            sessions: { others: "write" },
            accessPolicyPlugin: "test-handoff-policy",
          },
        },
      },
    },
  };
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(profileConfig));
  return {
    ...options,
    requester: {
      channel: "slack",
      accountId: "primary",
      senderId: "owner",
      authorizationSource: `profile:${profile.id}`,
    },
  };
}

export async function observeManagedServiceProfileRefusal(
  completion: Promise<number | null>,
  commandsPath: string,
): Promise<number | null> {
  const observation = new AbortController();
  try {
    return await Promise.race([
      completion,
      rejectUnexpectedServiceMutation(commandsPath, observation.signal),
    ]);
  } finally {
    observation.abort();
  }
}

function rejectUnexpectedServiceMutation(
  commandsPath: string,
  signal: AbortSignal,
): Promise<never> {
  return new Promise((_resolve, reject) => {
    const inspect = async () => {
      const contents = await fs.readFile(commandsPath, "utf8").catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return "";
        }
        throw error;
      });
      const mutation = contents
        .trim()
        .split("\n")
        .filter(Boolean)
        .find((command) => !isManagedServiceInspectionCommand(command));
      if (mutation) {
        throw new Error(`Refused profile update attempted a service mutation: ${mutation}`);
      }
    };
    const watcher = watch(path.dirname(commandsPath), (_event, filename) => {
      if (filename === path.basename(commandsPath)) {
        void inspect().catch(reject);
      }
    });
    watcher.once("error", reject);
    signal.addEventListener("abort", () => watcher.close(), { once: true });
    void inspect().catch(reject);
  });
}
