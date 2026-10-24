import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { linkUserChannelIdentity } from "../state/user-channel-identities.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
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
  const sender = { accountId: "primary", senderId: "owner" };
  linkUserChannelIdentity(profile.id, { channelId: "slack", ...sender }, { env });
  const admin: GatewayOperatorRoleDefinition = {
    scopes: ["operator.admin"],
    agents: "*",
    sessions: { others: "write" },
    accessPolicyPlugin: "test-handoff-policy",
  };
  const profileConfig: OpenClawConfig = {
    gateway: { roles: { default: "admin", definitions: { admin } } },
  };
  await fs.writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(profileConfig));
  return {
    ...options,
    requester: {
      channel: "slack",
      ...sender,
      authorizationSource: `profile:${profile.id}`,
    },
  };
}

export async function observeManagedServiceProfileRefusal(
  completion: Promise<number | null>,
  commandsPath: string,
): Promise<number | null> {
  const { promise, reject } = Promise.withResolvers<never>();
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
      .find((command) => command !== "" && !isManagedServiceInspectionCommand(command));
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
  void inspect().catch(reject);
  try {
    return await Promise.race([completion, promise]);
  } finally {
    watcher.close();
  }
}
