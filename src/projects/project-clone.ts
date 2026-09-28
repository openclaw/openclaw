import fs from "node:fs/promises";
import path from "node:path";
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { slugifyWorktreeTitle } from "../agents/worktrees/name.js";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { resolveProjectDirectory, withProjectCheckoutLifecycle } from "./project-checkout.js";
import {
  cloneProjectCheckout,
  ensureProjectCheckoutCommit,
  ProjectCloneError,
  refreshProjectCheckout,
} from "./project-clone-runtime.js";
import { parseProjectGitUrl } from "./project-git-url.js";
import {
  prepareProjectRegistration,
  registerPreparedProjectRegistry,
} from "./project-registration.js";
import {
  listProjectRegistry,
  removeProjectCheckoutReference,
  resolveProjectCloneRefreshOwner,
  type ProjectRegistryRecord,
} from "./project-registry.js";
import type { ProjectRegistryIdentity } from "./project-registry.kernel.js";

const PROJECT_CLONE_LEASE_MS = 30_000;
const PROJECT_CLONE_WAIT_MS = 30_000;

async function existingCanonicalProject(
  cfg: OpenClawConfig,
  canonicalUrl: string,
  options: OpenClawStateDatabaseOptions,
): Promise<ProjectRegistryRecord | undefined> {
  return (await listProjectRegistry(cfg, options)).find((project) => {
    const origin = project.originUrl ? parseProjectGitUrl(project.originUrl) : null;
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
  } = {},
): Promise<ProjectRegistryRecord> {
  const { cfg, gitUrl, name, requiredCommit } = input;
  const { signal, timeoutMs, token } = options;
  const parsed = parseProjectGitUrl(gitUrl);
  if (!parsed) {
    throw new ProjectCloneError(
      "invalid_url",
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
      // Keep clone as the outer lease and take one candidate checkout lease at a time. A row that
      // moves roots while we wait must be retried under its new root instead of returned stale.
      while (true) {
        const candidate = await existingCanonicalProject(cfg, parsed.url, databaseOptions);
        lease.assertOwned();
        if (!candidate) {
          break;
        }
        const existing = await withProjectCheckoutLifecycle(
          candidate.repoRoot,
          { ...databaseOptions, signal: lease.signal },
          async (checkoutLease) => {
            const current = await existingCanonicalProject(cfg, parsed.url, databaseOptions);
            lease.assertOwned();
            checkoutLease.assertOwned();
            if (current?.repoRoot !== candidate.repoRoot) {
              return undefined;
            }
            if (requiredCommit) {
              await ensureProjectCheckoutCommit(
                { url: parsed.url, target: current.repoRoot, commit: requiredCommit },
                { env, signal: checkoutLease.signal, timeoutMs, token },
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
      await cloneProjectCheckout(
        { url: parsed.url, target, requiredCommit },
        {
          env,
          signal: lease.signal,
          timeoutMs,
          token,
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
            lease.assertOwned();
            const prepared = await prepareProjectRegistration({
              path: repoRoot,
              name: displayName,
              originUrl: parsed.url,
              source: "cloned",
            });
            return await registerPreparedProjectRegistry(prepared, checkoutLease, context, () => {
              registered = true;
            });
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
  } = {},
): Promise<void> {
  if (project.source !== "cloned") {
    return;
  }
  const selectedProject: ProjectRegistryIdentity = {
    id: project.id,
    repoRoot: project.repoRoot,
    source: project.source,
    originUrl: project.originUrl,
  };
  const { signal, timeoutMs, token } = options;
  const env = cloneEnvWithPlatformSemantics(options.env ?? process.env);
  const context = captureOpenClawStateWorkerContext({ path: options.path, env });
  await withProjectCheckoutLifecycle(
    selectedProject.repoRoot,
    { path: context.admission.databasePath, env, signal },
    async (lease) => {
      // Removal and registration share this lease. Re-read now so a queued stale record cannot
      // authorize network, object-store, or ref effects after checkout ownership changes.
      const current = await resolveProjectCloneRefreshOwner(selectedProject, lease, context);
      lease.assertOwned();
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
      // The registry owns source identity; origin can be changed inside the shared checkout.
      await refreshProjectCheckout(
        { target: current.repoRoot, url: originUrl },
        { env, signal: lease.signal, timeoutMs, token },
      );
      lease.assertOwned();
    },
  );
}

async function resolveClonedProjectCheckout(
  project: ProjectRegistryRecord,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  if (project.source !== "cloned") {
    throw new ProjectCloneError(
      "clone_failed",
      "Only projects cloned by the Gateway can delete their checkout.",
    );
  }
  const managedRoot = await fs.realpath(path.join(resolveStateDir(options.env), "projects"));
  const checkout = await fs.realpath(project.repoRoot).catch(() => {
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
  return checkout;
}

/** Removes one cloned-project reference and deletes its checkout only after the final reference. */
export async function removeClonedProjectCheckout(
  project: ProjectRegistryRecord,
  assertUnreferenced: () => void | Promise<void>,
  options: OpenClawStateDatabaseOptions & { env?: NodeJS.ProcessEnv } = {},
): Promise<boolean> {
  return await withProjectCheckoutLifecycle(project.repoRoot, options, async (lease) => {
    const checkout = await resolveClonedProjectCheckout(project, options);
    await assertUnreferenced();
    const result = removeProjectCheckoutReference(project, lease, options);
    if (result === "missing") {
      return false;
    }
    if (result === "changed") {
      throw new ProjectCloneError("clone_failed", "The cloned project changed before deletion.");
    }
    if (result === "remaining") {
      return true;
    }
    lease.assertOwned();
    await fs.rm(checkout, { recursive: true });
    await fs.rmdir(path.dirname(checkout)).catch(() => {});
    return true;
  });
}
