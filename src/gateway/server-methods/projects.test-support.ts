import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { vi } from "vitest";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  bindLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../../plugins/legacy-sdk-resource-host.js";
import { withPluginRuntimeGatewayContextResolver } from "../../plugins/runtime/gateway-request-scope.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { withRestoredMocks } from "../../test-utils/vitest-spies.js";
import { installGitHubAccountRpcFixture } from "../github-account-service.test-support.js";
import { createRepositorySources } from "../repository-sources.js";
import { retainSessionListForegroundWork } from "../session-projection-work.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import {
  createSessionRowProjection,
  type SessionRowProjection,
} from "../session-row-projection.js";
import { createRepositorySourcesFixture } from "../worker-environments/repository-source.test-support.js";
import { projectsHandlers as nativeProjectsHandlers } from "./projects.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

const { repositoryProjectHandlers } = await loadBundledPluginFacade<{
  repositoryProjectHandlers: GatewayRequestHandlers;
}>({ pluginId: "github-repositories", artifactBasename: "runtime-api.ts" });
export const registeredProjectsHandlers = {
  ...nativeProjectsHandlers,
  ...repositoryProjectHandlers,
};

export const execFileAsync = promisify(execFile);
export const listRegistryRecords = vi.fn(async () => []);
export const resolveRepositoryIdentity = vi.fn(async (checkoutPath: string) => ({
  checkoutRoot: checkoutPath,
  repoRoot: checkoutPath,
  originUrl: "",
  fingerprint: checkoutPath,
}));
export const projectsHandlers: typeof registeredProjectsHandlers = {
  ...registeredProjectsHandlers,
  // mock-isolation: Only fixture listings replace discovery; registered handlers stay native.
  "projects.list": async (options) => {
    const registry = vi
      .spyOn(managedWorktrees, "listRegistryRecords")
      .mockImplementation(listRegistryRecords);
    const identities = vi
      .spyOn(managedWorktrees, "resolveRepositoryIdentities")
      .mockImplementation((roots) => Promise.all(roots.map(resolveRepositoryIdentity)));
    return await withRestoredMocks([registry, identities], () =>
      registeredProjectsHandlers["projects.list"]!(options),
    );
  },
};

export async function initializeRepository(
  root: string,
  name = "registered",
  originUrl = "https://github.com/openclaw/openclaw.git",
): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await execFileAsync("git", ["-C", repo, "config", "user.name", "OpenClaw Tests"]);
  await execFileAsync("git", ["-C", repo, "config", "user.email", "tests@openclaw.invalid"]);
  await execFileAsync("git", ["-C", repo, "remote", "add", "origin", originUrl]);
  await fs.writeFile(path.join(repo, "README.md"), "registered\n");
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
  return await fs.realpath(repo);
}

export async function invokeProjectMethod(
  method: keyof typeof projectsHandlers,
  params: Record<string, unknown>,
  cfg = {},
  scopes: string[] = ["operator.write"],
  profileId?: string,
  handlers = projectsHandlers,
  projection?: SessionRowProjection,
  getConfig: () => OpenClawConfig = () => cfg as OpenClawConfig,
  lifetime: { signal?: AbortSignal; hasCurrentClientAuthority?: () => boolean } = {},
) {
  const capture: {
    result: {
      ok: boolean;
      payload?: unknown;
      error?: { code?: string; message?: string };
    } | null;
  } = { result: null };
  const releaseForegroundWork = retainSessionListForegroundWork();
  let ownedProjection: SessionRowProjection | undefined;
  const resources = new LegacyPluginSdkResourceHost();
  try {
    ownedProjection =
      !projection && method === "projects.list" && (profileId || params.includeObserved)
        ? await createSessionRowProjection({ cfg, modelCatalog: [] })
        : undefined;
    const registry =
      method === "projects.add" ? installGitHubAccountRpcFixture(getConfig()) : undefined;
    const context = bindSessionRowProjection(
      {
        getRuntimeConfig: getConfig,
        trackExecution: trackAsyncWork,
        repositorySources: registry
          ? createRepositorySources(lifetime.signal ?? new AbortController().signal, registry)
          : createRepositorySourcesFixture(getConfig),
      },
      () => projection ?? ownedProjection,
    ) as GatewayRequestContext;
    context.resolveGatewayContext = () => context;
    bindLegacyPluginSdkResourceHost(context.resolveGatewayContext, resources);
    const handler =
      method === "projects.add" ? registry?.gatewayHandlers[method] : handlers[method];
    await withPluginRuntimeGatewayContextResolver(context.resolveGatewayContext, () =>
      handler!({
        ...lifetime,
        req: {} as never,
        params,
        respond: (ok, payload, error) => {
          capture.result = { ok, payload, error };
        },
        context,
        client: {
          connect: { scopes },
          ...(profileId ? { authenticatedUserProfile: { profileId } } : {}),
        } as never,
        isWebchatConnect: () => false,
      }),
    );
    return capture.result;
  } finally {
    await resources.close();
    ownedProjection?.dispose();
    releaseForegroundWork();
  }
}

export function withProjectState(run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState({ layout: "state-only", prefix: "projects-rpc-" }, run);
}
