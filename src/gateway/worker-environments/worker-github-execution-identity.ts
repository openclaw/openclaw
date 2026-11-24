import {
  assertAdmittedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../../agents/admitted-run-context.js";
import { GitHubAppInstallationRetryableError } from "../../agents/github-app-installation.js";
import { resolveGitHubApiBaseUrl, resolveGitHubHost } from "../../agents/github-host-runtime.js";
import { githubRepositoryUrl } from "../../agents/github-host.js";
import {
  matchesPreparedGitHubPublicationIdentity,
  resolveConfiguredGitHubToolIdentity,
} from "../../agents/github-tool-identity.js";
import type { PreparedGitHubPublicationIdentity } from "../../agents/github-tool-identity.types.js";
import type { AgentRunSessionTarget } from "../../agents/run-session-target.types.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { registerConfigWriteListener } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getRepositoryIntegration } from "../../plugins/repository-integration-runtime.js";
import { parseWorkerGitHubLaunchBinding } from "../../worker/launch-descriptor.js";
import {
  currentGitHubPublicationConfig,
  publicationConfigSnapshot,
  prepareGitHubPublicationSession,
  prepareGitHubPublicationRepositoryIdentity,
  prepareWorkerGitHubCheckoutOwner,
  repositoryPublicationPreflightCredential,
  matchesCurrentGitHubPublicationIdentity,
  prepareCurrentGitHubPublicationIdentity,
  sameGitHubPublicationWorkspace,
} from "../github-publication-availability.js";
import { requirePublicationSessionOwner } from "../github-publication-worktree-owner.js";
import { parseGitHubRemoteUrl } from "../github-remote.js";
import type {
  WorkerGitHubBindingGrant,
  WorkerGitHubBindingRefresh,
} from "./worker-github-binding-contract.js";
import { isWorkerGitHubRefreshAcknowledged } from "./worker-github-binding.js";

const log = createSubsystemLogger("gateway/worker-github");

/** A native worker receives only the selected execution identity under its current operator and session. */
export async function prepareWorkerGitHubExecutionGrant(params: {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  sessionTarget?: AgentRunSessionTarget;
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
  }
  const controller = new AbortController();
  const signal = AbortSignal.any(
    [controller.signal, params.signal, operator?.signal].filter((value): value is AbortSignal =>
      Boolean(value),
    ),
  );
  let closed = false;
  let retained = false;
  const assertAuthority = () => {
    signal.throwIfAborted();
    if (!retained && params.expectedProfileId) {
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
    if (closed || params.assertCurrent?.() === false) {
      throw new Error("Worker GitHub execution authority closed");
    }
  };
  assertAuthority();
  const session = await prepareGitHubPublicationSession(params.sessionKey, {
    agentId: params.agentId,
    assertCurrent: assertAuthority,
  });
  const host = resolveGitHubHost();
  const apiBaseUrl = resolveGitHubApiBaseUrl();
  let identity: Awaited<ReturnType<typeof prepareCurrentGitHubPublicationIdentity>> | undefined;
  let checkoutOwner: Awaited<ReturnType<typeof prepareWorkerGitHubCheckoutOwner>> | undefined;
  try {
    const loaded = session.readCurrent();
    const owner = requirePublicationSessionOwner(
      { ...params, sessionKey: loaded.canonicalKey },
      loaded,
      true,
    );
    const lifecycleRevision = owner.entry.lifecycleRevision ?? null;
    const target = { ...params, sessionKey: owner.canonicalKey, lifecycleRevision };
    // The integrated launch does not use background discovery's credential or checkout.
    if (
      repositoryIntegration &&
      configuredIdentity?.kind === "app-installation" &&
      params.sessionTarget &&
      (owner.entry.repositoryWorkspaceId || owner.entry.worktree?.id)
    ) {
      checkoutOwner = await prepareWorkerGitHubCheckoutOwner(target, {
        sessionTarget: params.sessionTarget,
        assertCurrent: assertAuthority,
      });
    }
    const assertCurrent = () => {
      assertAuthority();
      if (resolveGitHubHost() !== host || resolveGitHubApiBaseUrl() !== apiBaseUrl) {
        throw new Error("Worker GitHub issuer changed");
      }
      requirePublicationSessionOwner(target, session.readCurrent(), true);
      if (
        checkoutOwner &&
        !sameGitHubPublicationWorkspace(checkoutOwner.initial, checkoutOwner.current())
      ) {
        throw new Error("Worker GitHub workspace changed. Start a new turn.");
      }
      if (identity?.accessExpiresAtMs !== undefined && identity.accessExpiresAtMs <= Date.now()) {
        throw new Error("Worker GitHub credential expired");
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
    const checkout = checkoutOwner?.initial;
    const branch =
      checkout?.kind === "repository" ? checkout.workspace.branch : checkout?.worktree.branch;
    const origin =
      checkout?.kind === "repository"
        ? checkout.workspace.url
        : checkout &&
          (
            await prepareGitHubPublicationRepositoryIdentity({
              worktree: checkout.worktree,
              assertCurrent,
            })
          ).originUrl;
    const remote = origin && parseGitHubRemoteUrl(origin, identity.host);
    const remoteUrl =
      remote && /^[A-Za-z0-9_.-]+$/u.test(remote.owner) && /^[A-Za-z0-9_.-]+$/u.test(remote.repo)
        ? githubRepositoryUrl(`${remote.owner}/${remote.repo}`, identity.host)
        : undefined;
    assertCurrent();
    if (!matchesCurrentGitHubPublicationIdentity({ agentId: params.agentId, identity })) {
      throw new Error("Selected GitHub account changed; start a new turn");
    }
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
      ...(branch ? { branch } : {}),
      ...(remoteUrl ? { remoteUrl } : {}),
      ...(gitAuthor ? { gitAuthor } : {}),
    });
    if (!binding) {
      throw new Error("Selected GitHub execution identity cannot be installed on this worker");
    }
    const selectedIdentity = identity;
    const selection = { agentId: params.agentId, identity: selectedIdentity };
    const renewalSelectionChanged = new Error(
      "GitHub renewal requires the originally selected account",
    );
    const assertRenewalCurrent = () => {
      assertCurrent();
      if (!matchesCurrentGitHubPublicationIdentity(selection)) {
        throw renewalSelectionChanged;
      }
    };
    const credentials = new Set([identity]);
    let pending:
      | { identity: PreparedGitHubPublicationIdentity; update: WorkerGitHubBindingRefresh }
      | undefined;
    let generation = 0;
    let pendingWork: Promise<WorkerGitHubBindingRefresh | undefined> | undefined;
    let attemptedAt = Number.NEGATIVE_INFINITY;
    let revocation: Promise<void> | undefined;
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const revoke = () => {
      if (!revocation) {
        closed = true;
        clearTimeout(expiryTimer);
        signal.removeEventListener("abort", onAbort);
        stopWatchingConfig();
        controller.abort(new Error("Worker GitHub execution authority closed"));
        checkoutOwner?.release();
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
    const stopWatchingConfig = registerConfigWriteListener(() => {
      try {
        assertCurrent();
      } catch {
        onAbort();
      }
    });
    signal.addEventListener("abort", onAbort, { once: true });
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
          if (pending && isWorkerGitHubRefreshAcknowledged(pending.update, installedGeneration)) {
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
          const configSnapshot = publicationConfigSnapshot();
          // An already installed grant stays live. Fresh issuance checks the
          // selected identity through broker admission and the issuer call.
          if (
            !matchesPreparedGitHubPublicationIdentity({
              ...selection,
              config: configSnapshot.config,
            })
          ) {
            return undefined;
          }
          const replacement = await prepareCurrentGitHubPublicationIdentity(
            params.agentId,
            operator
              ? {
                  profileId: operator.profileId,
                  credentialSource: operator.repositoryCredentialSource,
                  sessionKey: params.sessionKey,
                  assertCurrent: assertRenewalCurrent,
                }
              : assertRenewalCurrent,
            repositoryPublicationPreflightCredential({
              agentId: params.agentId,
              sessionKey: params.sessionKey,
              sessionId: params.sessionId,
              lifecycleRevision,
              assertCurrent,
            }),
            true,
            configSnapshot,
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
            if (error === renewalSelectionChanged) {
              return undefined;
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
      checkoutOwner?.release();
      session.release();
      await identity?.revoke?.();
    }
  }
}
