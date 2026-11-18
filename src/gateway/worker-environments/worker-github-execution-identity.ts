import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { GitHubAppInstallationRetryableError } from "../../agents/github-app-installation.js";
import { resolveGitHubApiBaseUrl } from "../../agents/github-host-runtime.js";
import { resolveConfiguredGitHubToolIdentity } from "../../agents/github-tool-identity.js";
import type { PreparedGitHubPublicationIdentity } from "../../agents/github-tool-identity.types.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { registerConfigWriteListener } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getRepositoryIntegration } from "../../plugins/repository-integration-runtime.js";
import {
  onUserProfilesChanged,
  onUserProfileEmailBindingChanged,
} from "../../state/user-profile-events.js";
import { parseWorkerGitHubLaunchBinding } from "../../worker/launch-descriptor.js";
import {
  currentGitHubPublicationConfig,
  prepareGitHubPublicationSession,
  repositoryPublicationPreflightCredential,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
} from "../github-publication-availability.js";
import type {
  WorkerGitHubBindingGrant,
  WorkerGitHubBindingRefresh,
} from "./worker-github-binding-contract.js";

const log = createSubsystemLogger("gateway/worker-github");

/** A native worker receives only the selected execution identity under its current operator and session. */
export async function prepareWorkerGitHubExecutionGrant(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  expectedProfileId?: string;
  signal?: AbortSignal;
  assertCurrent?: () => boolean;
  operatorAuthority?: AdmittedRunOperatorAuthority;
}): Promise<WorkerGitHubBindingGrant | undefined> {
  const initialConfig = currentGitHubPublicationConfig();
  const repositoryIntegration = getRepositoryIntegration(initialConfig);
  const configuredIdentity =
    resolveConfiguredGitHubToolIdentity({
      config: initialConfig,
      agentId: params.agentId,
      scope: "agent",
    }) ??
    resolveConfiguredGitHubToolIdentity({
      config: initialConfig,
      agentId: params.agentId,
      scope: "system",
    });
  // Native worker inference did not opt into Gateway GitHub credentials. Leave its
  // own environment alone; optional host CLI discovery must not gate model startup.
  if (!configuredIdentity && !repositoryIntegration && !params.expectedProfileId) {
    return undefined;
  }
  const caller = getGatewayToolCallerIdentity();
  const operator =
    params.operatorAuthority ??
    (caller?.agentId === params.agentId && caller.sessionKey === params.sessionKey
      ? caller.operatorAuthority
      : undefined);
  if (repositoryIntegration && !operator) {
    throw new Error("Worker GitHub execution requires the verified operator and session.");
  }
  if (operator) {
    assertAdmittedRunOperatorAuthority(operator);
    operator.assertCurrent();
  }
  const controller = new AbortController();
  const signal = AbortSignal.any(
    [controller.signal, params.signal, operator?.signal].filter((value): value is AbortSignal =>
      Boolean(value),
    ),
  );
  let closed = false;
  const assertAuthority = () => {
    signal.throwIfAborted();
    if (params.expectedProfileId) {
      const config = currentGitHubPublicationConfig();
      const selected =
        resolveConfiguredGitHubToolIdentity({ config, agentId: params.agentId, scope: "agent" }) ??
        resolveConfiguredGitHubToolIdentity({ config, agentId: params.agentId, scope: "system" });
      if (
        selected?.kind !== "app-installation" ||
        selected.profileId !== params.expectedProfileId
      ) {
        throw new Error("Selected GitHub App changed; start a new turn");
      }
    }
    operator?.assertCurrent();
    if (closed || params.assertCurrent?.() === false) {
      throw new Error("Worker GitHub execution authority closed");
    }
  };
  assertAuthority();
  const session = await prepareGitHubPublicationSession(params.sessionKey, {
    agentId: params.agentId,
    assertCurrent: assertAuthority,
  });
  let retained = false;
  const apiBaseUrl = resolveGitHubApiBaseUrl();
  let identity: Awaited<ReturnType<typeof prepareCurrentGitHubPublicationIdentity>> | undefined;
  try {
    const loaded = session.readCurrent();
    if (loaded.entry?.sessionId !== params.sessionId || loaded.agentId !== params.agentId) {
      throw new Error("Worker GitHub session authority changed");
    }
    const lifecycleRevision = loaded.entry.lifecycleRevision ?? null;
    const assertCurrent = () => {
      assertAuthority();
      if (resolveGitHubApiBaseUrl() !== apiBaseUrl) {
        throw new Error("Worker GitHub issuer changed");
      }
      const current = session.readCurrent();
      if (
        current.entry?.sessionId !== params.sessionId ||
        (current.entry.lifecycleRevision ?? null) !== lifecycleRevision
      ) {
        throw new Error("Worker GitHub session authority changed");
      }
      if (
        identity &&
        (!matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity }) ||
          (identity.accessExpiresAtMs !== undefined && identity.accessExpiresAtMs <= Date.now()))
      ) {
        throw new Error("Worker GitHub credential expired or its selection changed");
      }
    };
    identity = await prepareCurrentGitHubPublicationIdentity(
      params.agentId,
      operator
        ? {
            profileId: operator.profileId,
            credentialSource: operator.repositoryCredentialSource,
            sessionKey: params.sessionKey,
            assertCurrent,
          }
        : undefined,
      repositoryPublicationPreflightCredential({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        lifecycleRevision,
        assertCurrent,
      }),
    );
    assertCurrent();
    const scope =
      identity.source === "agent-override"
        ? "agent"
        : identity.source === "system-configured"
          ? "system"
          : undefined;
    const gitAuthor = scope
      ? resolveConfiguredGitHubToolIdentity({
          config: currentGitHubPublicationConfig(),
          agentId: params.agentId,
          scope,
        })?.gitAuthor
      : undefined;
    const binding = parseWorkerGitHubLaunchBinding({
      token: identity.env.GH_TOKEN,
      host: identity.host,
      login: identity.account.login,
      ...(gitAuthor ? { gitAuthor } : {}),
    });
    if (!binding) {
      throw new Error("Selected GitHub execution identity cannot be installed on this worker");
    }
    const selectedIdentity = identity;
    const credentials = new Set([identity]);
    let pending:
      | { identity: PreparedGitHubPublicationIdentity; update: WorkerGitHubBindingRefresh }
      | undefined;
    let generation = 0;
    let pendingWork: Promise<WorkerGitHubBindingRefresh | undefined> | undefined;
    let attemptedAt = Number.NEGATIVE_INFINITY;
    let revocation: Promise<void> | undefined;
    const stops: (() => void)[] = [];
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const revoke = () => {
      if (!revocation) {
        closed = true;
        clearTimeout(expiryTimer);
        signal.removeEventListener("abort", onAbort);
        stops.splice(0).forEach((stop) => stop());
        controller.abort(new Error("Worker GitHub execution authority closed"));
        session.release();
        revocation = (async () => {
          // In-flight issuance owns its late-result cleanup before the grant can close.
          await pendingWork?.catch(() => {});
          const outcomes = await Promise.allSettled(
            [...credentials].map((value) => Promise.resolve(value.revoke?.())),
          );
          const failures = outcomes.flatMap((outcome) =>
            outcome.status === "rejected" ? [outcome.reason] : [],
          );
          if (failures.length) {
            throw new AggregateError(failures, "Worker GitHub credential cleanup failed");
          }
        })();
      }
      return revocation;
    };
    const onAbort = () => {
      void revoke().catch(() =>
        log.warn("GitHub App credential cleanup failed; retry cleanup before reusing the worker."),
      );
    };
    const armExpiry = () => {
      clearTimeout(expiryTimer);
      if (identity?.accessExpiresAtMs !== undefined) {
        expiryTimer = setTimeout(onAbort, Math.max(1, identity.accessExpiresAtMs - Date.now()));
        expiryTimer.unref?.();
      }
    };
    const changed = () => {
      try {
        assertCurrent();
      } catch {
        onAbort();
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    stops.push(
      registerConfigWriteListener(changed),
      onUserProfilesChanged(changed),
      onUserProfileEmailBindingChanged(changed),
    );
    armExpiry();
    assertCurrent();
    retained = true;
    return {
      binding,
      signal,
      assertCurrent,
      revoke,
      refresh(installedGeneration) {
        pendingWork ??= (async () => {
          assertCurrent();
          if (pending && installedGeneration === pending.update.generation) {
            identity = pending.identity;
            pending = undefined;
            // ACK advances only the installed deadline. Running commands keep their old
            // token's original validity; the turn's terminal cleanup still owns revocation.
            armExpiry();
          }
          if (pending) {
            return pending.update;
          }
          const expiresAt = identity?.accessExpiresAtMs;
          if (
            expiresAt === undefined ||
            expiresAt > Date.now() + 5 * 60_000 ||
            Date.now() - attemptedAt < 30_000
          ) {
            return undefined;
          }
          attemptedAt = Date.now();
          const replacement = await prepareCurrentGitHubPublicationIdentity(
            params.agentId,
            operator
              ? {
                  profileId: operator.profileId,
                  credentialSource: operator.repositoryCredentialSource,
                  sessionKey: params.sessionKey,
                  assertCurrent,
                }
              : assertCurrent,
            repositoryPublicationPreflightCredential({
              agentId: params.agentId,
              sessionKey: params.sessionKey,
              sessionId: params.sessionId,
              lifecycleRevision,
              assertCurrent,
            }),
          );
          const knownToken = [...credentials].some(
            (value) => value.env.GH_TOKEN === replacement.env.GH_TOKEN,
          );
          credentials.add(replacement);
          assertCurrent();
          if (
            replacement.source !== selectedIdentity.source ||
            replacement.profileId !== selectedIdentity.profileId ||
            replacement.host !== selectedIdentity.host ||
            replacement.account.accountId !== selectedIdentity.account.accountId ||
            replacement.account.login.toLowerCase() !==
              selectedIdentity.account.login.toLowerCase() ||
            !replacement.env.GH_TOKEN
          ) {
            throw new Error("Selected GitHub account or issuer changed; start a new turn");
          }
          // Re-reading an unchanged bearer never renews its lifetime or revokes it.
          if (knownToken) {
            if (replacement !== identity) {
              credentials.delete(replacement);
            }
            return undefined;
          }
          if (
            replacement.accessExpiresAtMs === undefined ||
            replacement.accessExpiresAtMs <= Date.now()
          ) {
            throw new Error("Renewed GitHub credential has no usable expiry");
          }
          pending = {
            identity: replacement,
            update: {
              generation: ++generation,
              token: replacement.env.GH_TOKEN,
              expiresAtMs: replacement.accessExpiresAtMs,
            },
          };
          return pending.update;
        })()
          .catch((error: unknown) => {
            try {
              assertCurrent();
            } catch (authorityError) {
              onAbort();
              throw authorityError;
            }
            if (error instanceof GitHubAppInstallationRetryableError) {
              log.warn(
                "Worker GitHub renewal failed; retrying while the installed credential remains usable.",
              );
              return undefined;
            }
            onAbort();
            throw error;
          })
          .finally(() => {
            pendingWork = undefined;
          });
        return pendingWork;
      },
    };
  } finally {
    if (!retained) {
      session.release();
      await identity?.revoke?.();
    }
  }
}
