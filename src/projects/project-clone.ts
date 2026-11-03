import fs from "node:fs/promises";
import path from "node:path";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { resolveConfiguredGitHubHost } from "../agents/github-host.js";
import { slugifyWorktreeTitle } from "../agents/worktrees/name.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import type { GitOperationStarter } from "../infra/git-network-retry.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { ManagedProjectOptions, ManagedProjectSourceV1 } from "./managed-project-source.js";
import { resolveProjectDirectory, withProjectCheckoutLifecycle } from "./project-checkout.js";
import {
  cloneProjectCheckout,
  configureProjectCheckoutMaintenance,
  ensureProjectCheckoutCommit,
  ProjectCloneError,
  refreshProjectCheckout,
} from "./project-clone-runtime.js";
import { parseProjectGitUrl } from "./project-git-url.js";
import {
  prepareProjectRegistration,
  registerPreparedProjectRegistry,
} from "./project-registration.js";
import { listProjectRegistry } from "./project-registry.js";
import type { ProjectRegistryIdentity, ProjectRegistryRecord } from "./project-registry.types.js";

const PROJECT_CLONE_LEASE_MS = 30_000;
const PROJECT_CLONE_WAIT_MS = 30_000;

async function existingCanonicalProject(
  cfg: OpenClawConfig,
  canonicalUrl: string,
  options: OpenClawStateDatabaseOptions,
  source?: Pick<ManagedProjectSourceV1, "resolveUrl">,
): Promise<ProjectRegistryRecord | undefined> {
  return (await listProjectRegistry(cfg, options)).find((project) => {
    const origin = project.originUrl
      ? source
        ? source.resolveUrl(project.originUrl)
        : parseProjectGitUrl(project.originUrl, resolveConfiguredGitHubHost(cfg))
      : null;
    return origin?.url === canonicalUrl;
  });
}

/** Materializes and registers a project from an accepted GitHub remote. */
export async function materializeProjectClone(
  input: { cfg: OpenClawConfig; gitUrl: string; name?: string; requiredCommit?: string },
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
    signal?: AbortSignal;
    timeoutMs?: number;
    token?: string;
    assertCurrent?: () => void;
    startRun?: GitOperationStarter;
  } = {},
  source?: Pick<
    ManagedProjectSourceV1,
    "resolveUrl" | "invalidUrlMessage" | "clone" | "ensureCommit"
  >,
): Promise<ProjectRegistryRecord> {
  const { cfg, gitUrl, name, requiredCommit } = input;
  const { signal, timeoutMs, token, assertCurrent, startRun } = options;
  const parsed = source
    ? source.resolveUrl(gitUrl)
    : parseProjectGitUrl(gitUrl, resolveConfiguredGitHubHost(cfg));
  if (!parsed) {
    throw new ProjectCloneError(
      "invalid_url",
      source?.invalidUrlMessage ??
        "Use a GitHub HTTPS or git@github.com repository URL. Local paths and file URLs are not accepted.",
    );
  }
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const context = captureOpenClawStateWorkerContext({ path: options.path, env });
  const databaseOptions = { path: context.admission.databasePath, env };
  const fingerprint = sha256HexPrefixCore(parsed.url, 16);
  return await withOpenClawStateLease(
    {
      scope: "projects.clone",
      key: fingerprint,
      database: { scope: "shared", options: databaseOptions },
      leaseMs: PROJECT_CLONE_LEASE_MS,
      waitMs: PROJECT_CLONE_WAIT_MS,
      ...(signal ? { signal } : {}),
      leaseLabel: "project clone lease",
      operationLabel: "projects.clone.lease",
    },
    async (lease) => {
      const assertCloneCurrent = () => {
        lease.assertOwned();
        assertCurrent?.();
      };
      // Keep clone as the outer lease and take one candidate checkout lease at a time. A row that
      // moves roots while we wait must be retried under its new root instead of returned stale.
      while (true) {
        const candidate = await existingCanonicalProject(cfg, parsed.url, databaseOptions, source);
        assertCloneCurrent();
        if (!candidate) {
          break;
        }
        const existing = await withProjectCheckoutLifecycle(
          candidate.repoRoot,
          { ...databaseOptions, signal: lease.signal },
          async (checkoutLease) => {
            const current = await existingCanonicalProject(
              cfg,
              parsed.url,
              databaseOptions,
              source,
            );
            assertCloneCurrent();
            checkoutLease.assertOwned();
            if (current?.repoRoot !== candidate.repoRoot) {
              return undefined;
            }
            if (current.source === "cloned") {
              await configureProjectCheckoutMaintenance(current.repoRoot, {
                env,
                signal: checkoutLease.signal,
                assertCurrent: () => {
                  assertCloneCurrent();
                  checkoutLease.assertOwned();
                },
              });
            }
            if (requiredCommit) {
              await (source?.ensureCommit ?? ensureProjectCheckoutCommit)(
                { url: parsed.url, target: current.repoRoot, commit: requiredCommit },
                {
                  env,
                  signal: checkoutLease.signal,
                  timeoutMs,
                  token,
                  startRun,
                  assertCurrent: () => {
                    assertCloneCurrent();
                    checkoutLease.assertOwned();
                  },
                },
              );
              checkoutLease.assertOwned();
            }
            return current;
          },
        );
        if (existing) {
          return existing;
        }
      }
      const displayName = name?.trim() || parsed.name;
      const directoryName = slugifyWorktreeTitle(displayName) ?? "project";
      const target = path.join(resolveStateDir(env), "projects", fingerprint, directoryName);
      await (source?.clone ?? cloneProjectCheckout)(
        { url: parsed.url, target, requiredCommit },
        {
          env,
          signal: lease.signal,
          timeoutMs,
          token,
          assertCurrent: assertCloneCurrent,
          startRun,
        },
      );
      lease.assertOwned();
      const repoRoot = await resolveProjectDirectory(target);
      lease.assertOwned();
      return await withProjectCheckoutLifecycle(
        repoRoot,
        { ...databaseOptions, signal: lease.signal },
        async (checkoutLease) => {
          let registered = false;
          try {
            assertCloneCurrent();
            const prepared = await prepareProjectRegistration({
              path: repoRoot,
              name: displayName,
              originUrl: parsed.url,
              source: "cloned",
            });
            return await registerPreparedProjectRegistry(
              prepared,
              checkoutLease,
              context,
              () => {
                registered = true;
              },
              assertCloneCurrent,
            );
          } catch (error) {
            if (
              registered ||
              collectNestedErrorCandidates(error).some(
                (candidate) => extractErrorCode(candidate) === "outcome-unknown",
              )
            ) {
              throw error;
            }
            try {
              lease.assertOwned();
              checkoutLease.assertOwned();
              await fs.rm(target, { recursive: true, force: true });
            } catch {
              // Preserve the registration failure if ownership verification or cleanup fails.
            }
            throw error;
          }
        },
      );
    },
  );
}

/** Refreshes an existing project clone while holding its checkout lifecycle lease. */
export async function refreshProjectClone(
  project: ProjectRegistryRecord,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> & {
    signal?: AbortSignal;
    timeoutMs?: number;
    token?: string;
    assertCurrent?: () => void;
    startRun?: GitOperationStarter;
  } = {},
  source?: ManagedProjectSourceV1,
): Promise<void> {
  if (project.source !== "cloned") {
    return;
  }
  const { token, startRun } = options;
  await withCurrentProjectClone(project, options, (input, admitted) =>
    (source?.refresh ?? refreshProjectCheckout)(input, { ...admitted, token, startRun }),
  );
}

/** Source transport resolves facts only while the host owns the exact managed checkout. */
export async function resolveProjectCloneBase(
  project: ProjectRegistryRecord,
  ref: string | undefined,
  options: NonNullable<Parameters<typeof refreshProjectClone>[1]>,
  source: ManagedProjectSourceV1,
) {
  return await withCurrentProjectClone(project, options, (input, admitted) =>
    source.resolveBase({ ...input, ref }, admitted),
  );
}

async function withCurrentProjectClone<T>(
  project: ProjectRegistryRecord,
  options: NonNullable<Parameters<typeof refreshProjectClone>[1]>,
  run: (
    input: { target: string; url: string },
    options: ManagedProjectOptions & {
      env: NodeJS.ProcessEnv;
      assertCurrent: () => void;
    },
  ) => Promise<T>,
): Promise<T> {
  const selectedProject: ProjectRegistryIdentity = {
    id: project.id,
    repoRoot: project.repoRoot,
    source: project.source,
    originUrl: project.originUrl,
  };
  const { signal, timeoutMs, assertCurrent } = options;
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const context = captureOpenClawStateWorkerContext({ path: options.path, env });
  return await withProjectCheckoutLifecycle(
    selectedProject.repoRoot,
    { path: context.admission.databasePath, env, signal },
    async (lease) => {
      const assertRefreshCurrent = () => {
        lease.assertOwned();
        assertCurrent?.();
      };
      // Removal and registration share this lease. Re-read now so a queued stale record cannot
      // authorize network, object-store, or ref effects after checkout ownership changes.
      const { runWithOpenClawStateLeaseWorker } =
        await import("../state/openclaw-state-lease-worker-operation.js");
      const current = await runWithOpenClawStateLeaseWorker(lease, context, (scope, identity) =>
        scope.execute({
          type: "projects.resolveRefreshOwner",
          input: { project: selectedProject, lease: identity },
        }),
      );
      assertRefreshCurrent();
      if (!current) {
        throw new ProjectCloneError(
          "clone_failed",
          "This project is no longer a Gateway-managed clone. Reselect the repository and retry.",
        );
      }
      // Materialization validates the source URL; retries retain that registry identity.
      const originUrl = current.originUrl;
      if (!originUrl) {
        throw new ProjectCloneError(
          "invalid_url",
          "Saved project repository is invalid; select the repository and retry.",
        );
      }
      await configureProjectCheckoutMaintenance(current.repoRoot, {
        env,
        signal: lease.signal,
        assertCurrent: assertRefreshCurrent,
      });
      // The registry owns source identity; origin can be changed inside the shared checkout.
      const value = await run(
        { target: current.repoRoot, url: originUrl },
        { env, signal: lease.signal, timeoutMs, assertCurrent: assertRefreshCurrent },
      );
      assertRefreshCurrent();
      return value;
    },
  );
}

/** Removes one cloned-project reference and deletes its checkout only after the final reference. */
export async function removeClonedProjectCheckout(
  project: ProjectRegistryRecord,
  assertUnreferenced: () => void | Promise<void>,
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> & { assertCurrent?: () => void } = {},
): Promise<boolean> {
  const selectedProject = { ...project };
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const context = captureOpenClawStateWorkerContext({ path: options.path, env });
  const databaseOptions = { path: context.admission.databasePath, env };
  return await withProjectCheckoutLifecycle(
    selectedProject.repoRoot,
    databaseOptions,
    async (lease) => {
      if (selectedProject.source !== "cloned") {
        throw new ProjectCloneError(
          "clone_failed",
          "Only projects cloned by the Gateway can delete their checkout.",
        );
      }
      const managedRoot = await fs.realpath(
        path.join(resolveStateDir(databaseOptions.env), "projects"),
      );
      const checkout = await fs.realpath(selectedProject.repoRoot).catch(() => {
        throw new ProjectCloneError(
          "clone_failed",
          "The managed project checkout is already unavailable. Remove only its registry entry instead.",
        );
      });
      const relative = path.relative(managedRoot, checkout);
      const segments = relative.split(path.sep);
      if (
        !relative ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        segments.length !== 2 ||
        !/^[a-f0-9]{16}$/u.test(segments[0] ?? "")
      ) {
        throw new ProjectCloneError(
          "clone_failed",
          "The cloned project is outside the Gateway-managed projects area, so its checkout was not deleted.",
        );
      }
      lease.assertOwned();
      await assertUnreferenced();
      const { runWithOpenClawStateLeaseWorker } =
        await import("../state/openclaw-state-lease-worker-operation.js");
      const result = await runWithOpenClawStateLeaseWorker(
        lease,
        context,
        (scope, identity) =>
          scope.execute({
            type: "projects.removeCheckoutReference",
            input: { project: selectedProject, lease: identity },
          }),
        options.assertCurrent ? { assertCurrent: options.assertCurrent } : undefined,
      );
      if (result === "missing") {
        return false;
      }
      if (result === "changed") {
        throw new ProjectCloneError("clone_failed", "The cloned project changed before deletion.");
      }
      if (result === "remaining") {
        return true;
      }
      await assertUnreferenced();
      context.admission.assertCurrent();
      lease.assertOwned();
      options.assertCurrent?.();
      await fs.rm(checkout, { recursive: true });
      context.admission.assertCurrent();
      lease.assertOwned();
      await fs.rmdir(path.dirname(checkout)).catch(() => {});
      return true;
    },
  );
}
