import { randomUUID } from "node:crypto";
import { validateGitLabOAuthConfig } from "../agents/gitlab-host.js";
import {
  createGitLabAuthorization,
  exchangeGitLabAuthorization,
  refreshGitLabAuthorization,
  verifyGitLabAccount,
  type GitLabAccount,
} from "../agents/gitlab-oauth-client.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseGitLabOAuthCallback } from "../shared/gitlab-oauth-callback.js";
import {
  prepareUserGitLabConnection,
  readUserGitLabConnectionAsync,
  replaceUserGitLabConnection,
  claimUserGitLabAuthorization,
  beginUserGitLabRefresh,
  settleUserGitLabRefresh,
  disconnectUserGitLabConnection,
  type UserGitLabConnection,
} from "../state/user-gitlab-connections.js";
import { fingerprintGitLabOAuthConfig } from "./gitlab-oauth-config-fingerprint.js";
import type { PersonalForgeAction } from "./server-methods/personal-forge-authorization.js";

export type PersonalGitLabCredential = {
  account: GitLabAccount;
  generation: string;
  assertCurrent: () => void;
  withToken: <T>(run: (token: string) => Promise<T>) => Promise<T>;
};

/** One Gateway lifetime owns personal linking and rotation for all GitLab operations. */
export function createPersonalGitLabOAuthLifecycle(getConfig: () => OpenClawConfig) {
  const lifetime = new AbortController();
  const refreshes = new Map<string, Promise<void>>();
  const pending = new Set<Promise<unknown>>();
  const configuration = () => {
    const cfg = getConfig().gateway?.gitlab;
    if (!cfg) {
      throw new Error("Personal GitLab is not configured.");
    }
    return validateGitLabOAuthConfig(cfg);
  };
  const bind = (action: PersonalForgeAction) => {
    action.assertCurrent();
    lifetime.signal.throwIfAborted();
    const config = configuration();
    const captured = fingerprintGitLabOAuthConfig(config);
    return {
      config,
      signal: AbortSignal.any([action.signal, lifetime.signal]),
      assertCurrent() {
        action.assertCurrent();
        lifetime.signal.throwIfAborted();
        if (fingerprintGitLabOAuthConfig(configuration()) !== captured) {
          throw new Error("GitLab configuration changed; reconnect.");
        }
      },
    };
  };
  const tracked = async <T>(run: () => Promise<T>): Promise<T> => {
    const result = run();
    pending.add(result);
    try {
      return await result;
    } finally {
      pending.delete(result);
    }
  };
  const status = async (action: PersonalForgeAction) => {
    const bound = bind(action);
    const record = await readUserGitLabConnectionAsync(action.owner, bound.config.issuer);
    bound.assertCurrent();
    const selected = record?.selection;
    return {
      configured: true,
      issuer: bound.config.issuer,
      pendingRequestId: record?.pending?.requestId,
      connected: selected?.kind === "connected" && !selected.refresh && !selected.refreshFailure,
      account: selected?.kind === "connected" ? selected.account : null,
      scopes: selected?.kind === "connected" ? selected.tokens.scopes : [],
      reconnectRequired:
        selected?.kind === "connected" && Boolean(selected.refresh || selected.refreshFailure),
    };
  };
  return {
    status,
    start: (action: PersonalForgeAction) =>
      tracked(async () => {
        const bound = bind(action);
        const current = await readUserGitLabConnectionAsync(action.owner, bound.config.issuer);
        bound.assertCurrent();
        const authorization = createGitLabAuthorization(bound.config);
        const requestId = randomUUID();
        const createdAtMs = Date.now();
        const next: UserGitLabConnection = {
          version: 1,
          issuer: bound.config.issuer,
          generation: randomUUID(),
          // Starting another login invalidates old selections, including pending work.
          selection: { kind: "disconnected" },
          pending: {
            requestId,
            state: authorization.state,
            verifier: authorization.verifier,
            createdAtMs,
            expiresAtMs: createdAtMs + 10 * 60_000,
            configFingerprint: fingerprintGitLabOAuthConfig(bound.config),
          },
        };
        await replaceUserGitLabConnection(
          action.owner,
          bound.config.issuer,
          current?.generation,
          next,
          () => bound.assertCurrent(),
        );
        bound.assertCurrent();
        return {
          requestId,
          authorizationUrl: authorization.url,
          expiresAtMs: createdAtMs + 10 * 60_000,
        };
      }),
    complete: (action: PersonalForgeAction, requestId: string, callbackUrl: string) =>
      tracked(async () => {
        const bound = bind(action);
        const { code, state } = parseGitLabOAuthCallback(bound.config.redirectUri, callbackUrl);
        const current = await readUserGitLabConnectionAsync(action.owner, bound.config.issuer);
        bound.assertCurrent();
        if (
          !current?.pending ||
          current.pending.configFingerprint !== fingerprintGitLabOAuthConfig(bound.config)
        ) {
          throw new Error("GitLab authorization changed; start again.");
        }
        // The native worker consumes the exact owner-bound state before any token request.
        const claimed = await claimUserGitLabAuthorization(
          action.owner,
          bound.config.issuer,
          current.generation,
          requestId,
          state,
          () => bound.assertCurrent(),
        );
        const prepared = await prepareUserGitLabConnection(action.owner, bound.config.issuer);
        const generation = prepared.read()?.generation;
        const assertCurrent = () => {
          bound.assertCurrent();
          if (prepared.read()?.generation !== generation) {
            throw new Error("GitLab authorization changed; start again.");
          }
        };
        assertCurrent();
        const tokens = await exchangeGitLabAuthorization(bound.config, {
          code,
          verifier: claimed.verifier,
          signal: bound.signal,
          assertCurrent,
        });
        const account = await verifyGitLabAccount(bound.config, tokens, {
          signal: bound.signal,
          assertCurrent,
        });
        assertCurrent();
        await replaceUserGitLabConnection(
          action.owner,
          bound.config.issuer,
          generation,
          {
            version: 1,
            issuer: bound.config.issuer,
            generation: randomUUID(),
            selection: { kind: "connected", account, tokens },
          },
          assertCurrent,
        );
        return status(action);
      }),
    disconnect: (action: PersonalForgeAction) =>
      tracked(async () => {
        const bound = bind(action);
        const record = await readUserGitLabConnectionAsync(action.owner, bound.config.issuer);
        await disconnectUserGitLabConnection(
          action.owner,
          bound.config.issuer,
          record?.generation,
          () => bound.assertCurrent(),
        );
        return { disconnected: true };
      }),
    credential: (action: PersonalForgeAction): Promise<PersonalGitLabCredential> =>
      tracked(async () => {
        const bound = bind(action);
        let record = await readUserGitLabConnectionAsync(action.owner, bound.config.issuer);
        bound.assertCurrent();
        if (record?.selection.kind !== "connected") {
          throw new Error("Connect your personal GitLab account in Profile settings first.");
        }
        if (record.selection.refresh || record.selection.refreshFailure) {
          const inflight = refreshes.get(JSON.stringify([action.owner, bound.config.issuer]));
          if (!inflight) {
            throw new Error("GitLab refresh is unconfirmed; reconnect your own account.");
          }
          await inflight;
          record = await readUserGitLabConnectionAsync(action.owner, bound.config.issuer);
          bound.assertCurrent();
        }
        if (record?.selection.kind !== "connected") {
          throw new Error("Personal GitLab authorization is unavailable.");
        }
        if (record.selection.tokens.expiresAtMs <= Date.now() + 60_000) {
          const key = JSON.stringify([action.owner, bound.config.issuer]);
          let refreshing = refreshes.get(key);
          if (!refreshing) {
            const original = record;
            const selected = record.selection;
            refreshing = (async () => {
              const operationId = randomUUID();
              await beginUserGitLabRefresh(
                action.owner,
                bound.config.issuer,
                original.generation,
                operationId,
                () => bound.assertCurrent(),
              );
              try {
                const tokens = await refreshGitLabAuthorization(bound.config, {
                  refreshToken: selected.tokens.refreshToken,
                  signal: bound.signal,
                  assertCurrent: () => bound.assertCurrent(),
                });
                // Rotation settlement records an already accepted effect; it grants no later action.
                if (
                  !(await settleUserGitLabRefresh(action.owner, bound.config.issuer, operationId, {
                    kind: "rotated",
                    tokens,
                  }))
                ) {
                  throw new Error("Personal GitLab selection changed during refresh.");
                }
              } catch {
                await settleUserGitLabRefresh(action.owner, bound.config.issuer, operationId, {
                  kind: "failed",
                  failure: "failed",
                });
                throw new Error(
                  "GitLab refresh could not be confirmed; reconnect your own account.",
                );
              }
            })().finally(() => refreshes.delete(key));
            refreshes.set(key, refreshing);
          }
          await refreshing;
        }
        const prepared = await prepareUserGitLabConnection(action.owner, bound.config.issuer);
        const selectedRecord = prepared.read();
        if (
          selectedRecord?.selection.kind !== "connected" ||
          selectedRecord.selection.refresh ||
          selectedRecord.selection.refreshFailure
        ) {
          throw new Error("Personal GitLab authorization is unavailable; reconnect.");
        }
        const selected = selectedRecord.selection;
        const assertCurrent = () => {
          bound.assertCurrent();
          const current = prepared.read();
          if (
            current?.generation !== selectedRecord.generation ||
            selected.tokens.expiresAtMs <= Date.now()
          ) {
            throw new Error("Personal GitLab authorization changed or expired.");
          }
        };
        const account = await verifyGitLabAccount(bound.config, selected.tokens, {
          signal: bound.signal,
          assertCurrent,
        });
        assertCurrent();
        if (
          account.accountId !== selected.account.accountId ||
          account.login !== selected.account.login ||
          account.commitEmail !== selected.account.commitEmail ||
          account.name !== selected.account.name
        ) {
          throw new Error("GitLab account identity changed; reconnect your own account.");
        }
        return {
          account,
          generation: selectedRecord.generation,
          assertCurrent,
          withToken: async <T>(run: (token: string) => Promise<T>): Promise<T> => {
            assertCurrent();
            const result = await run(selected.tokens.accessToken);
            assertCurrent();
            return result;
          },
        };
      }),
    async stop() {
      lifetime.abort();
      await Promise.allSettled(pending);
    },
  };
}
