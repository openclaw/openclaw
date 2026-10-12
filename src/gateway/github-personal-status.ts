import type {
  PersonalGitHubStatus,
  UsersGitHubAuthorizeStartResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
import { preparePersonalGitHubPublicationIdentity } from "../agents/github-tool-identity.js";
import {
  prepareUserGitHubConnection,
  readUserGitHubConnection,
  type UserGitHubConnection,
  type UserGitHubDevice,
} from "../state/user-github-connections.js";

export type PersonalGitHubAction = { owner: string; assertCurrent: () => void };

export function projectPending(pending: UserGitHubDevice): UsersGitHubAuthorizeStartResult {
  return {
    requestId: pending.requestId,
    userCode: pending.userCode,
    verificationUri: pending.verificationUri,
    expiresInMs: Math.max(0, pending.expiresAtMs - Date.now()),
    pollAfterMs: Math.max(1, Math.min(60000, pending.nextPollAtMs - Date.now())),
  };
}

const statusAuthorities = new WeakMap<PersonalGitHubStatus, () => void>();

export function personalGitHubStatus(action: PersonalGitHubAction): PersonalGitHubStatus {
  action.assertCurrent();
  try {
    return projectPersonalGitHubStatus(readUserGitHubConnection(action.owner));
  } catch {
    action.assertCurrent();
    return unavailablePersonalGitHubStatus();
  }
}

function unavailablePersonalGitHubStatus(): PersonalGitHubStatus {
  return {
    state: "unavailable",
    generation: null,
    account: null,
    accessExpiresAtMs: null,
    refreshState: "failed",
    pending: null,
  };
}

export async function personalGitHubStatusAsync(
  action: PersonalGitHubAction,
): Promise<PersonalGitHubStatus> {
  action.assertCurrent();
  try {
    const prepared = await prepareUserGitHubConnection(action.owner);
    action.assertCurrent();
    const status = projectPersonalGitHubStatus(prepared.connection);
    statusAuthorities.set(status, prepared.assertCurrent);
    return status;
  } catch {
    action.assertCurrent();
    return unavailablePersonalGitHubStatus();
  }
}

function projectPersonalGitHubStatus(
  record: UserGitHubConnection | undefined,
): PersonalGitHubStatus {
  const selection = record?.selection;
  const connected = selection?.kind === "connected" ? selection : undefined;
  return {
    state: connected ? "connected" : "disconnected",
    generation: record?.generation ?? null,
    account: connected ? { accountId: connected.accountId, login: connected.login } : null,
    accessExpiresAtMs: connected?.accessExpiresAtMs ?? null,
    refreshState: !connected
      ? "not_applicable"
      : connected.refresh
        ? "refreshing"
        : (connected.refreshFailure ??
          (connected.refreshExpiresAtMs <= Date.now() ? "expired" : "available")),
    pending:
      record?.pending?.kind === "device" && record.pending.expiresAtMs > Date.now()
        ? projectPending(record.pending)
        : null,
  };
}

export function revalidatePersonalGitHubStatus(
  action: PersonalGitHubAction,
  prepared: PersonalGitHubStatus,
): PersonalGitHubStatus {
  action.assertCurrent();
  statusAuthorities.get(prepared)?.();
  return prepared;
}

export async function resolvePersonalGitHubStatus(
  action: PersonalGitHubAction,
): Promise<PersonalGitHubStatus> {
  action.assertCurrent();
  let prepared: Awaited<ReturnType<typeof prepareUserGitHubConnection>>;
  try {
    prepared = await prepareUserGitHubConnection(action.owner);
  } catch {
    action.assertCurrent();
    return {
      state: "unavailable",
      generation: null,
      account: null,
      accessExpiresAtMs: null,
      refreshState: "failed",
      pending: null,
    };
  }
  action.assertCurrent();
  const record = prepared.connection;
  const status = projectPersonalGitHubStatus(record);
  statusAuthorities.set(status, prepared.assertCurrent);
  if (status.state !== "connected") {
    return status;
  }
  if (record?.selection.kind !== "connected") {
    return { ...status, state: "unavailable" };
  }
  const assertCurrent = () => {
    revalidatePersonalGitHubStatus(action, status);
  };
  try {
    // Receipts use the durable selection above; live status must additionally
    // prove the selected profile can authenticate without borrowing native auth.
    const identity = await preparePersonalGitHubPublicationIdentity({
      profileId: record.selection.profileId,
      accountId: record.selection.accountId,
      assertCurrent,
      forDisplay: true,
    });
    const result = {
      ...revalidatePersonalGitHubStatus(action, status),
      ...(identity.stale ? { stale: true } : {}),
    };
    statusAuthorities.set(result, prepared.assertCurrent);
    return result;
  } catch {
    const result = {
      ...revalidatePersonalGitHubStatus(action, status),
      state: "unavailable" as const,
    };
    statusAuthorities.set(result, prepared.assertCurrent);
    return result;
  }
}
