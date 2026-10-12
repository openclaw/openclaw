import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type {
  PersonalGitHubStatus,
  UsersGitHubAuthorizePollResult,
  UsersGitHubAuthorizeStartResult,
} from "../../packages/gateway-protocol/src/schema/users.js";
import {
  refreshGitHubOAuthToken,
  type GitHubOAuthTokenPair,
} from "../agents/github-oauth-client.js";
import { clearNativeGitHubTokenCache } from "../agents/github-read-identity.js";
import {
  createManagedGitHubProfileId,
  installManagedGitHubProfile,
  preparePersonalGitHubPublicationIdentity,
  refreshManagedGitHubProfile,
  removeManagedGitHubProfile,
  resolveManagedGitHubProfileDir,
  resolveManagedGitHubProfileRoot,
} from "../agents/github-tool-identity.js";
import { hasErrnoCode } from "../infra/errno.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import {
  cancelUserGitHubAuthorizationSync,
  disconnectUserGitHubConnectionSync,
  listUserGitHubConnectionsAsync,
  mutateUserGitHubConnection as mutateConnection,
  observeUserGitHubProfileRetirement,
  prepareUserGitHubConnection,
  readCanonicalUserGitHubConnectionAsync,
  readPreparedUserGitHubConnection,
  readUserGitHubConnectionAsync,
  updateUserGitHubRefreshAsync as updateRefresh,
  type UserGitHubConnection,
  type UserGitHubConnected,
  type UserGitHubDevice,
} from "../state/user-github-connections.js";
import { assertGitHubCliAvailable } from "./github-cli-preflight.js";
import { pollGitHubDeviceFlow, startGitHubDeviceFlow } from "./github-oauth-device-flow.js";
import { warnGitHubPublicationDeprecation } from "./github-publication-deprecation.js";

export type PersonalGitHubAction = { owner: string; assertCurrent: () => void };
export type PersonalGitHubActionV2 = PersonalGitHubAction & { signal: AbortSignal };
const profileDir = (profileId: string) =>
  resolveManagedGitHubProfileDir({ agentId: "", scope: "personal", profileId });
const withProfileLease = <T>(profileId: string, run: (assertOwned: () => void) => Promise<T>) =>
  withOpenClawStateLease(
    {
      scope: "personal-github-profile",
      key: profileId,
      database: { scope: "shared" },
      leaseMs: 60000,
      waitMs: 30000,
    },
    async (lease) => await run(() => lease.assertOwned()),
  );

function projectPending(pending: UserGitHubDevice): UsersGitHubAuthorizeStartResult {
  return {
    requestId: pending.requestId,
    userCode: pending.userCode,
    verificationUri: pending.verificationUri,
    expiresInMs: Math.max(0, pending.expiresAtMs - Date.now()),
    pollAfterMs: Math.max(1, Math.min(60000, pending.nextPollAtMs - Date.now())),
  };
}

export function personalGitHubStatus(action: PersonalGitHubAction): PersonalGitHubStatus {
  action.assertCurrent();
  let record: UserGitHubConnection | undefined;
  try {
    record = readPreparedUserGitHubConnection(action.owner);
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
  return projectPersonalGitHubStatus(record);
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

function revalidatePersonalGitHubStatus(
  action: PersonalGitHubAction,
  prepared: PersonalGitHubStatus,
): PersonalGitHubStatus {
  const current = personalGitHubStatus(action);
  if (
    current.generation !== prepared.generation ||
    current.account?.accountId !== prepared.account?.accountId ||
    current.account?.login.toLowerCase() !== prepared.account?.login.toLowerCase()
  ) {
    throw new Error("My GitHub connection changed; reload its status.");
  }
  // Revalidating selection does not refresh the prepared account facts.
  if (prepared.stale) {
    current.stale = true;
  }
  return prepared.state === "unavailable" ? { ...current, state: "unavailable" } : current;
}

async function resolvePersonalGitHubStatus(
  action: PersonalGitHubAction,
): Promise<PersonalGitHubStatus> {
  action.assertCurrent();
  let record: UserGitHubConnection | undefined;
  try {
    record = await readUserGitHubConnectionAsync(action.owner);
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
  const status = projectPersonalGitHubStatus(record);
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
    return {
      ...revalidatePersonalGitHubStatus(action, status),
      ...(identity.stale ? { stale: true } : {}),
    };
  } catch {
    return { ...revalidatePersonalGitHubStatus(action, status), state: "unavailable" };
  }
}

function requirePending(
  record: UserGitHubConnection | undefined,
  generation: string,
  requestId: string,
): UserGitHubConnection & { pending: NonNullable<UserGitHubConnection["pending"]> } {
  if (
    !record?.pending ||
    record.generation !== generation ||
    record.pending.requestId !== requestId ||
    record.pending.expiresAtMs <= Date.now()
  ) {
    throw new Error("My GitHub authorization changed or expired; start again.");
  }
  return { ...record, pending: record.pending };
}

function needsRefresh(selection: UserGitHubConnected): boolean {
  return (
    Boolean(selection.refresh?.tokens) ||
    (selection.refreshFailure !== "expired" &&
      selection.refreshExpiresAtMs > Date.now() &&
      (Boolean(selection.refresh) || selection.accessExpiresAtMs <= Date.now() + 600000))
  );
}

/** Personal adapters share device transport and profile materialization with System/agent OAuth. */
export function createPersonalGitHubOAuthLifecycle() {
  const abort = new AbortController();
  const polls = new Map<string, Promise<UsersGitHubAuthorizePollResult>>();
  const refreshes = new Map<string, Promise<void>>();
  const rotated = new Map<
    string,
    {
      owner: string;
      profileId: string;
      operationId: string;
      tokens: GitHubOAuthTokenPair;
      receivedAtMs: number;
    }
  >();
  const writes = new Set<Promise<unknown>>();
  const retainWrite = <T>(work: Promise<T>): Promise<T> => {
    writes.add(work);
    void work.then(
      () => writes.delete(work),
      () => writes.delete(work),
    );
    return work;
  };
  const mutateUserGitHubConnection = (...args: Parameters<typeof mutateConnection>) =>
    retainWrite(mutateConnection(...args));
  const updateUserGitHubRefreshAsync = (...args: Parameters<typeof updateRefresh>) =>
    retainWrite(updateRefresh(...args));
  const retirements = new Set<string>();
  const cleanups = new Map<string, Promise<void>>();
  let stopped = false;
  let inspectedProfiles = false;
  const profileIsReferenced = async (id: string) =>
    (await listUserGitHubConnectionsAsync()).some(
      ({ connection }) =>
        (connection.selection.kind === "connected" && connection.selection.profileId === id) ||
        (connection.pending?.kind === "device" && connection.pending.candidate?.profileId === id),
    );
  const assertRunning = () => {
    if (stopped) {
      throw new Error("GitHub authorization is stopping.");
    }
  };
  const retire = async (id: string) => {
    await getOrCreatePromise(
      cleanups,
      id,
      () =>
        withProfileLease(id, async (assertOwned) => {
          assertOwned();
          if (await profileIsReferenced(id)) {
            return;
          }
          assertOwned();
          await removeManagedGitHubProfile(profileDir(id));
        }).then(
          () => {
            retirements.delete(id);
          },
          () => {
            retirements.add(id);
          },
        ),
      { evictOnSettled: true },
    );
  };
  const unobserve = observeUserGitHubProfileRetirement((ids) => {
    for (const id of ids) {
      retirements.add(id);
      void retire(id);
    }
  });
  const guard = (action: PersonalGitHubAction) => {
    assertRunning();
    action.assertCurrent();
  };

  const install = async (
    action: PersonalGitHubAction,
    generation: string,
    pending: UserGitHubDevice,
  ): Promise<UsersGitHubAuthorizePollResult> => {
    const candidate = pending.candidate;
    if (!candidate) {
      throw new Error("My GitHub authorization has no candidate.");
    }
    const prepared = await prepareUserGitHubConnection(action.owner);
    const assertCurrent = () => {
      guard(action);
      const record = requirePending(prepared.read(), generation, pending.requestId);
      if (
        record.pending.kind !== "device" ||
        record.pending.candidate?.profileId !== candidate.profileId
      ) {
        throw new Error("My GitHub authorization changed.");
      }
    };
    try {
      await withProfileLease(candidate.profileId, async (assertOwned) => {
        const assertInstall = () => {
          assertOwned();
          assertCurrent();
        };
        assertInstall();
        // A prior attempt may have materialized the inactive candidate before losing its response.
        await removeManagedGitHubProfile(profileDir(candidate.profileId));
        assertInstall();
        await installManagedGitHubProfile({
          profileDir: profileDir(candidate.profileId),
          token: candidate.tokens.accessToken,
          assertCurrent: assertInstall,
          commitConfig: async (account) => {
            await mutateUserGitHubConnection(
              action.owner,
              {
                kind: "connect",
                generation,
                requestId: pending.requestId,
                profileId: candidate.profileId,
                accountId: account.accountId,
                login: account.login,
              },
              () => {
                assertOwned();
                guard(action);
              },
            );
          },
        });
      });
      guard(action);
      return { status: "success", personal: await resolvePersonalGitHubStatus(action) };
    } catch {
      guard(action);
      return { status: "failed", reason: "setup_failed" };
    }
  };

  const pollOnce = async (
    action: PersonalGitHubAction,
    initial: UserGitHubConnection,
    requestId: string,
  ): Promise<UsersGitHubAuthorizePollResult> => {
    const pending = initial.pending;
    if (!pending || pending.requestId !== requestId || pending.expiresAtMs <= Date.now()) {
      return { status: "expired" };
    }
    if (pending.kind === "starting") {
      return { status: "pending", retryAfterMs: 1000 };
    }
    if (pending.candidate) {
      return await install(action, initial.generation, pending);
    }
    const polled = await pollGitHubDeviceFlow(pending, abort.signal);
    guard(action);
    let next: UserGitHubConnection;
    try {
      const connection = await mutateUserGitHubConnection(
        action.owner,
        {
          kind: "poll",
          generation: initial.generation,
          requestId,
          deviceCode: pending.deviceCode,
          result:
            polled.kind === "terminal"
              ? { kind: "terminal" }
              : polled.kind === "authorized"
                ? {
                    kind: "candidate",
                    candidate: {
                      receivedAtMs: Date.now(),
                      profileId: createManagedGitHubProfileId(),
                      tokens: polled.tokens,
                    },
                  }
                : {
                    kind: "pending",
                    pollIntervalMs: polled.pollIntervalMs,
                    nextPollAtMs: polled.nextPollAtMs,
                  },
        },
        () => guard(action),
      );
      if (!connection) {
        throw new Error("My GitHub authorization changed.");
      }
      next = connection;
    } catch {
      guard(action);
      return { status: "failed", reason: "identity_changed" };
    }
    if (polled.kind !== "authorized") {
      return polled.result;
    }
    if (next.pending?.kind !== "device") {
      throw new Error("My GitHub authorization changed.");
    }
    return await install(action, next.generation, next.pending);
  };

  const persistRotation = (
    pending: NonNullable<ReturnType<typeof rotated.get>>,
  ): Promise<boolean> =>
    updateUserGitHubRefreshAsync(
      {
        owner: pending.owner,
        profileId: pending.profileId,
        operationId: pending.operationId,
        result: { kind: "rotated", tokens: pending.tokens, receivedAtMs: pending.receivedAtMs },
      },
      () => {},
    );
  const materializeRefresh = async (
    owner: string,
    id: string,
    operationId: string,
    assertOwned: () => void,
  ): Promise<void> => {
    const canonical = await readCanonicalUserGitHubConnectionAsync(owner);
    if (!canonical) {
      throw new Error("My GitHub refresh ownership changed.");
    }
    const prepared = await prepareUserGitHubConnection(canonical.owner);
    const readExact = () => {
      assertOwned();
      const selection = prepared.read()?.selection;
      if (
        selection?.kind !== "connected" ||
        selection.profileId !== id ||
        selection.refresh?.operationId !== operationId ||
        !selection.refresh.tokens
      ) {
        throw new Error("My GitHub refresh ownership changed.");
      }
      return selection;
    };
    const current = readExact();
    const account = await refreshManagedGitHubProfile({
      profileDir: profileDir(id),
      token: current.refresh!.tokens!.accessToken,
      expectedAccountId: current.accountId,
      assertCurrent: () => {
        readExact();
      },
    });
    assertOwned();
    await updateUserGitHubRefreshAsync(
      {
        owner,
        profileId: id,
        operationId,
        result: { kind: "materialized", login: account.login },
      },
      assertOwned,
    );
  };

  const refresh = async (owner: string): Promise<void> => {
    assertRunning();
    const initial = (await readUserGitHubConnectionAsync(owner))?.selection;
    assertRunning();
    if (initial?.kind !== "connected") {
      return;
    }
    const id = initial.profileId;
    if (!rotated.has(id) && !needsRefresh(initial)) {
      return;
    }
    await getOrCreatePromise(
      refreshes,
      id,
      () =>
        withProfileLease(id, async (assertOwned) => {
          const memory = rotated.get(id);
          if (memory) {
            if (!(await persistRotation(memory))) {
              rotated.delete(id);
              return;
            }
            rotated.delete(id);
          }
          const record = await readUserGitHubConnectionAsync(owner);
          const selection = record?.selection;
          if (
            !record ||
            selection?.kind !== "connected" ||
            selection.profileId !== id ||
            !needsRefresh(selection)
          ) {
            return;
          }
          if (selection.refresh?.tokens) {
            await materializeRefresh(owner, id, selection.refresh.operationId, assertOwned);
            return;
          }
          const operationId = selection.refresh?.operationId ?? randomUUID();
          await mutateUserGitHubConnection(
            owner,
            { kind: "beginRefresh", generation: record.generation, profileId: id, operationId },
            assertOwned,
          );
          assertOwned();
          let result;
          try {
            // Refresh rotates remote credentials: shutdown drains this bounded exchange, never aborts it.
            result = await refreshGitHubOAuthToken({
              refreshToken: selection.refreshToken,
            });
          } catch {
            await updateUserGitHubRefreshAsync(
              { owner, profileId: id, operationId, result: { kind: "failed", failure: "failed" } },
              assertOwned,
            );
            return;
          }
          if (result.status === "error") {
            await updateUserGitHubRefreshAsync(
              {
                owner,
                profileId: id,
                operationId,
                result: {
                  kind: "failed",
                  failure: result.code === "bad_refresh_token" ? "expired" : "failed",
                },
              },
              assertOwned,
            );
            return;
          }
          // Persist remote rotation even if the initiating request closed or its profile merged.
          // The exact operation CAS fences disconnect/replacement; memory retries use that same CAS.
          const pending = {
            owner,
            profileId: id,
            operationId,
            tokens: result.tokens,
            receivedAtMs: Date.now(),
          };
          rotated.set(id, pending);
          if (!(await persistRotation(pending))) {
            rotated.delete(id);
            return;
          }
          rotated.delete(id);
          await materializeRefresh(owner, id, operationId, assertOwned);
        }),
      { evictOnSettled: true },
    );
  };

  let maintenance: Promise<void> | undefined;
  const runMaintenance = async (): Promise<void> => {
    if (!inspectedProfiles) {
      const root = resolveManagedGitHubProfileRoot({ agentId: "", scope: "personal" });
      const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return [];
        }
        throw error;
      });
      for (const entry of entries) {
        if (
          entry.isDirectory() &&
          /^ghp_[a-f0-9]{32}$/u.test(entry.name) &&
          !(await profileIsReferenced(entry.name))
        ) {
          retirements.add(entry.name);
        }
      }
      inspectedProfiles = true;
    }
    for (const pending of rotated.values()) {
      try {
        await persistRotation(pending);
        rotated.delete(pending.profileId);
      } catch {
        /* Keep the exact rotated pair for the next durable write. */
      }
    }
    for (const id of retirements) {
      await retire(id);
    }
    for (const { owner, connection } of await listUserGitHubConnectionsAsync()) {
      if (stopped) {
        break;
      }
      if (connection.pending && connection.pending.expiresAtMs <= Date.now()) {
        await mutateUserGitHubConnection(
          owner,
          { kind: "expire", nowMs: Date.now() },
          assertRunning,
        );
      }
      try {
        await refresh(owner);
      } catch {
        /* Exact pending recovery remains durable for retry. */
      }
    }
  };

  return {
    status: resolvePersonalGitHubStatus,
    revalidateStatus: revalidatePersonalGitHubStatus,
    async startAuthorization(
      action: PersonalGitHubAction,
    ): Promise<UsersGitHubAuthorizeStartResult> {
      guard(action);
      assertGitHubCliAvailable();
      const requestId = randomUUID();
      const createdAtMs = Date.now();
      const initial = await mutateUserGitHubConnection(
        action.owner,
        { kind: "start", requestId, createdAtMs, expiresAtMs: createdAtMs + 900000 },
        () => guard(action),
      );
      if (!initial) {
        throw new Error("My GitHub authorization changed.");
      }
      guard(action);
      const authorization = await startGitHubDeviceFlow(abort.signal);
      guard(action);
      if (authorization.expiresAtMs <= Date.now()) {
        throw new Error("My GitHub authorization expired while starting; start again.");
      }
      const next = await mutateUserGitHubConnection(
        action.owner,
        {
          kind: "device",
          generation: initial.generation,
          requestId,
          device: { ...authorization, kind: "device", requestId },
        },
        () => guard(action),
      );
      if (next?.pending?.kind !== "device") {
        throw new Error("My GitHub authorization changed.");
      }
      return projectPending(next.pending);
    },
    async pollAuthorization(
      action: PersonalGitHubAction,
      requestId: string,
    ): Promise<UsersGitHubAuthorizePollResult> {
      guard(action);
      const current = await readUserGitHubConnectionAsync(action.owner);
      guard(action);
      if (current?.pending?.requestId !== requestId) {
        return { status: "expired" };
      }
      const key = `${action.owner}\0${requestId}`;
      const result = await getOrCreatePromise(
        polls,
        key,
        () => pollOnce(action, current, requestId),
        { evictOnSettled: true },
      );
      guard(action);
      return result;
    },
    /** @deprecated Use cancelAuthorizationAsync; removed in the next Plugin SDK major. */
    cancelAuthorization(action: PersonalGitHubAction, requestId: string): boolean {
      warnGitHubPublicationDeprecation("personal.cancelAuthorization");
      return cancelUserGitHubAuthorizationSync(action.owner, requestId, () => guard(action));
    },
    async cancelAuthorizationAsync(
      action: PersonalGitHubAction,
      requestId: string,
    ): Promise<boolean> {
      guard(action);
      return Boolean(
        await mutateUserGitHubConnection(action.owner, { kind: "cancel", requestId }, () =>
          guard(action),
        ),
      );
    },
    /** @deprecated Use disconnectAsync; removed in the next Plugin SDK major. */
    disconnect(action: PersonalGitHubAction): void {
      warnGitHubPublicationDeprecation("personal.disconnect");
      disconnectUserGitHubConnectionSync(action.owner, () => guard(action));
      clearNativeGitHubTokenCache();
    },
    async disconnectAsync(action: PersonalGitHubAction): Promise<void> {
      guard(action);
      await mutateUserGitHubConnection(action.owner, { kind: "disconnect" }, () => guard(action));
      clearNativeGitHubTokenCache();
    },
    refresh,
    maintain(): Promise<void> {
      if (stopped) {
        return Promise.resolve();
      }
      maintenance ??= runMaintenance().finally(() => {
        maintenance = undefined;
      });
      return maintenance;
    },
    async stop(): Promise<void> {
      stopped = true;
      abort.abort();
      unobserve();
      await Promise.allSettled([
        ...(maintenance ? [maintenance] : []),
        ...writes,
        ...polls.values(),
        ...refreshes.values(),
        ...cleanups.values(),
      ]);
      for (const pending of rotated.values()) {
        try {
          await persistRotation(pending);
        } catch {
          /* In-memory rotation remains owned until process exit. */
        }
      }
    },
  };
}
