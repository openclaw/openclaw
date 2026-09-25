import { isDeepStrictEqual } from "node:util";
import { isInternalMessageChannel } from "../utils/message-channel.js";
import { resolveInstallationTarget } from "./installation-target-context.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

export type UpdateRequester = {
  channel?: string;
  accountId?: string;
  senderId?: string;
  /** Captured by the original admission; private handoffs preserve it without granting authority. */
  authorizationSource?: string;
};
export type UpdateRequesterAuthority = Readonly<{
  requester: Readonly<UpdateRequester>;
  /** False means revoked; unavailable policy throws so the run records its actual failure. */
  isCurrent: () => boolean;
}>;

/** Only external chat requesters delegate command-owner authority to the updater. */
export function resolveManagedUpdateRequester(
  requester: UpdateRequester | undefined,
): UpdateRequester | undefined {
  return requester?.channel && !isInternalMessageChannel(requester.channel) ? requester : undefined;
}

export class UpdateRequesterRevokedError extends Error {
  readonly code = "requester-revoked";

  constructor() {
    super("requester-revoked");
    this.name = "UpdateRequesterRevokedError";
  }
}

/** Bind the admitted requester to fresh, read-only policy from its original installation. */
export async function createManagedUpdateRequesterAuthority(
  requester: UpdateRequester,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateRequesterAuthority> {
  return captureManagedUpdateRequester(requester, env, (auth) => auth.resolveCommandOwnerAuthority);
}

/** Identity facts alone grant no effects; the helper composes them with its native owner. */
export async function prepareManagedUpdateRequesterIdentity(
  requester: UpdateRequester,
  env: NodeJS.ProcessEnv = process.env,
) {
  const identity = await captureManagedUpdateRequester(
    requester,
    env,
    (auth) => auth.resolveUpdateRequesterIdentityAuthority,
  );
  return Object.freeze({
    requester: identity.requester,
    isCurrentIdentity: identity.isCurrent,
  });
}

/** Only a registered native continuation can settle the original Gateway's accepted update. */
export async function createManagedUpdateRequesterContinuationAuthority(
  requester: UpdateRequester,
  operation: { runId: string; executor: UpdateRecoveryFence },
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateRequesterAuthority> {
  const { runId, executor } = operation;
  const admittedRequester = Object.freeze({ ...requester });
  const authorityEnv = { ...env };
  const { assertUpdateRequesterContinuationOwner } =
    await import("../cli/update-cli/update-command-executor.js");
  const assertOperationCurrent = () => assertUpdateRequesterContinuationOwner(executor, runId);
  assertOperationCurrent();
  const { getUpdateRun } = await import("./update-run-ledger.js");
  assertOperationCurrent();
  const run = getUpdateRun(runId, { env: authorityEnv });
  if (
    run?.status !== "running" ||
    !isDeepStrictEqual(run.origin.requester, admittedRequester) ||
    !admittedRequester.authorizationSource?.startsWith("profile:")
  ) {
    throw new UpdateRequesterRevokedError();
  }
  const identity = await prepareManagedUpdateRequesterIdentity(admittedRequester, authorityEnv);
  assertOperationCurrent();
  return Object.freeze({
    requester: identity.requester,
    isCurrent: () => {
      assertOperationCurrent();
      return identity.isCurrentIdentity();
    },
  });
}

async function captureManagedUpdateRequester(
  requester: UpdateRequester,
  env: NodeJS.ProcessEnv,
  selectResolver: (
    auth: Pick<
      typeof import("../auto-reply/command-auth.js"),
      "resolveCommandOwnerAuthority" | "resolveUpdateRequesterIdentityAuthority"
    >,
  ) => typeof import("../auto-reply/command-auth.js").resolveCommandOwnerAuthority,
): Promise<UpdateRequesterAuthority> {
  // Released drivers knew only configured owners. They must not acquire a newly linked profile
  // when an installed runtime later reconstructs their authority.
  const authorizationSource = requester.authorizationSource ?? "configured-owner";
  const admittedRequester = Object.freeze({ ...requester });
  try {
    const authorityEnv = { ...env };
    const target = resolveInstallationTarget(authorityEnv);
    const [
      {
        isConfiguredCommandOwner,
        resolveCommandOwnerAuthority,
        resolveUpdateRequesterIdentityAuthority,
      },
      { readCurrentConfigForPolicyCheck },
      { ensureCliPluginRegistryLoaded },
    ] = await Promise.all([
      import("../auto-reply/command-auth.js"),
      // Keep synchronous authority checks on the reader loaded at admission.
      import("../config/io.js"),
      import("../cli/plugin-registry-loader.js"),
    ]);
    const readCurrentConfig = () =>
      readCurrentConfigForPolicyCheck({
        env: authorityEnv,
        configPath: target.configPath,
      });
    await ensureCliPluginRegistryLoaded({
      scope: "configured-channels",
      routeLogsToStderr: true,
      config: readCurrentConfig(),
    });
    const authority =
      authorizationSource === "configured-owner"
        ? undefined
        : selectResolver({ resolveCommandOwnerAuthority, resolveUpdateRequesterIdentityAuthority })(
            readCurrentConfig(),
            admittedRequester,
            {
              env: authorityEnv,
            },
          );
    return Object.freeze({
      requester: admittedRequester,
      isCurrent: () => {
        const config = readCurrentConfig();
        return authorizationSource === "configured-owner"
          ? isConfiguredCommandOwner(config, admittedRequester)
          : authority?.source === authorizationSource && authority.isCurrent(config);
      },
    });
  } catch (error) {
    // Admission and worker startup precede run failure reporting. Surface failed
    // preparation at the authority check, inside the owning run's error boundary.
    return Object.freeze({
      requester: admittedRequester,
      isCurrent: () => {
        throw error;
      },
    });
  }
}
