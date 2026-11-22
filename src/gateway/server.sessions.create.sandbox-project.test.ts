import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { runGitReadOperation } from "../infra/git-read-cache.js";
import * as directoryObservation from "../infra/owned-directory-observation.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "./server-methods.js";
import {
  identifiedClient,
  initializeSessionReadContext,
} from "./server-methods/sessions-read-cache.test-support.js";
import { initializeRepository } from "./server.sessions.create.projects.test-support.js";
import { testState } from "./test-helpers.js";
import { setupGatewaySessionsHandlerTestHarness } from "./test/server-sessions.test-helpers.js";

// This suite does not resolve bundled plugin surfaces; keep the GitHub transport
// contract (JSON body, statusCode on failure) over the stubbed global fetch.
vi.mock("./github-public-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-public-api.js")>()),
  gitHubPublicApi: {
    fetchGitHubJson: async (url: string, fetchImpl: typeof fetch) => {
      const response = await fetchImpl(url);
      if (!response.ok) {
        throw Object.assign(new Error(`GitHub ${response.status}`), {
          statusCode: response.status,
        });
      }
      return await response.json();
    },
  },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();
const execFileAsync = promisify(execFile);

async function publishOrigin(repo: string, name: string) {
  await execFileAsync("git", [
    "-C",
    repo,
    "config",
    "remote.origin.url",
    `https://github.com/${name}.git`,
  ]);
}

/** Restricted roles see only repositories GitHub reports as public. */
function stubRepositoryVisibility(visibility: Record<string, string>) {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const value = visibility[new URL(url).pathname.replace(/^\/repos\//u, "")];
    return new Response(JSON.stringify(value ? { visibility: value } : { message: "Not Found" }), {
      status: value ? 200 : 404,
      headers: { "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchImpl);
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  return fetchImpl;
}

test.each(["all", "off"] as const)(
  "guest project checkout eligibility preserves creation admission (agent sandbox=%s)",
  async (mode) => {
    const root = tempDirs.make("openclaw-session-sandbox-project-");
    const workspace = await initializeRepository(root, "workspace");
    const outside = await initializeRepository(root, "outside");
    const liveWatchDirectories = new Set([
      workspace,
      path.join(workspace, ".git"),
      path.join(workspace, ".git", "refs"),
    ]);
    const watchAdmissions: Promise<void>[] = [];
    const observe = directoryObservation.observeOwnedDirectory;
    const observation = vi
      .spyOn(directoryObservation, "observeOwnedDirectory")
      .mockImplementation((directory, changed, options) => {
        if (!liveWatchDirectories.has(directory)) {
          return observe(directory, changed, options);
        }
        const admitted = Promise.withResolvers<void>();
        watchAdmissions.push(admitted.promise);
        return observe(
          directory,
          (filename, event) => {
            admitted.resolve();
            changed(filename, event);
          },
          options,
        );
      });
    onTestFinished(() => observation.mockRestore());
    const repository = `openclaw/sandbox-project-${mode}`;
    await publishOrigin(outside, repository);
    const visibility = { [repository]: "public" };
    stubRepositoryVisibility(visibility);
    testState.agentConfig = { workspace, sandbox: { mode } };
    const { storePath } = await createSessionStoreDir();
    const project = await registerProjectRegistry({ path: outside });

    const profile = ensureProfileForEmail("project-guest@example.test");
    const client = identifiedClient(profile.id);
    client.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
    const baseCfg = getRuntimeConfig();
    const makeConfig = (requireSandbox = true) => ({
      ...baseCfg,
      agents: {
        ...baseCfg.agents,
        entries: {
          ...baseCfg.agents?.entries,
          main: { ...baseCfg.agents?.entries?.main, workspace, sandbox: { mode } },
          other: { workspace: outside },
        },
      },
      gateway: {
        roles: {
          default: "guest",
          definitions: {
            guest: {
              scopes: ["operator.sessions.read" as const, "operator.sessions.write" as const],
              agents: ["main"],
              sessions: { others: "none" as const },
              sandbox: requireSandbox ? ("required" as const) : undefined,
            },
          },
        },
      },
    });
    const cfg = makeConfig();
    let activeCfg: ReturnType<typeof getRuntimeConfig> = cfg;
    const context = createDirectChatContext({ getRuntimeConfig: () => activeCfg });
    context.readPreparedGatewayModelCatalog = async () => {
      const catalog = await context.loadGatewayModelCatalogSnapshot();
      return { entries: catalog.entries, routeVariants: catalog.routeVariants };
    };
    await initializeSessionReadContext(context);
    const request = async (method: string, params: Record<string, unknown>) => {
      const respond = vi.fn();
      const req = {
        type: "req" as const,
        id: method,
        method,
        params:
          method === "sessions.create" || method === "projects.checkoutOptions"
            ? { agentId: "main", ...params }
            : params,
      };
      await handleGatewayRequest({ req, client, context, respond, isWebchatConnect: () => false });
      expect(respond).toHaveBeenCalledOnce();
      return respond.mock.calls[0];
    };
    const expectOptions = async (projectId: string, current: boolean, worktree: boolean) => {
      let result = await request("projects.checkoutOptions", { projectId });
      if (current && projectId.startsWith("workspace:")) {
        expect(result).toEqual([true, { current, worktree: false, refreshing: true }, undefined]);
        const joinRefresh = async () => {
          const refreshed = Promise.withResolvers<void>();
          const snapshot = await runGitReadOperation(
            {
              type: "repository.branches",
              input: {
                repoRoot: projectId === "workspace:main" ? workspace : outside,
                includeRepositoryStatus: true,
              },
            },
            { snapshot: true, onRefresh: refreshed.resolve },
          );
          if (snapshot.refreshing) {
            await refreshed.promise;
          }
        };
        await joinRefresh();
        // Native watch admission invalidates once to cover the asynchronous startup gap.
        await Promise.all(watchAdmissions);
        await joinRefresh();
        result = await request("projects.checkoutOptions", { projectId });
      }
      expect(result).toEqual([true, { current, worktree }, undefined]);
    };
    if (mode === "off") {
      activeCfg = makeConfig(false);
      await expectOptions(project.id, true, true);
      // A prior availability response grants nothing after the effective requirement changes.
      activeCfg = cfg;
    }
    await expectOptions(project.id, false, true);
    await expectOptions("workspace:main", true, true);
    await expectOptions("workspace:other", false, false);
    for (const { projectId, worktree } of [
      { projectId: project.id, worktree: false },
      { projectId: project.id, worktree: true },
      { projectId: "workspace:other", worktree: true },
    ]) {
      const [ok, result, error] = (await request("sessions.create", {
        projectId,
        ...(worktree ? { worktree: true } : {}),
      }))!;
      if (worktree && projectId === project.id) {
        expect(ok, JSON.stringify(error)).toBe(true);
        const { key, worktree: checkout } = expectDefined(
          result,
          "managed sandbox session payload",
        ) as {
          key: string;
          worktree: { id: string; path: string };
        };
        const record = await managedWorktrees.findLiveByOwner("session", key);
        expect(record).toMatchObject({ id: checkout.id, path: checkout.path, repoRoot: outside });
        expect(checkout.path).not.toBe(outside);
        expect(loadSessionEntry({ agentId: "main", sessionKey: key, storePath })).toMatchObject({
          worktree: { id: checkout.id },
          createdActor: { type: "human", id: profile.id },
        });
        expect(await fs.readFile(path.join(checkout.path, "README.md"), "utf8")).toBe("outside\n");
        continue;
      }
      expect({ ok, error }).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "sessions.create project is outside the sandboxed agent workspace",
        },
      });
    }
    // A cached public picker answer cannot authorize source after visibility changes.
    visibility[repository] = "private";
    expect(await request("sessions.create", { projectId: project.id, worktree: true })).toEqual([
      false,
      undefined,
      { code: "INVALID_REQUEST", message: `unknown project id: ${project.id}` },
    ]);
    await expectOptions(project.id, false, false);
    const [, listed] = (await request("projects.list", {}))!;
    expect(
      (listed as { projects: { id: string }[] }).projects.map((entry) => entry.id),
    ).not.toContain(project.id);
    for (const [method, params] of [
      ["sessions.create", { projectGitUrl: `https://github.com/${repository}.git` }],
      ["projects.searchRemote", { query: repository }],
      ["worktrees.list", {}],
    ] as const) {
      const denied = await request(method, params);
      expect(denied?.[0], method).toBe(false);
      expect(JSON.stringify(denied?.[2]), method).toContain("operator.write");
    }
  },
);

test("role project grants open private projects only in isolated worktrees", async () => {
  const root = tempDirs.make("openclaw-session-project-grant-");
  const workspace = await initializeRepository(root, "workspace");
  const privateRepo = await initializeRepository(root, "private");
  const publicRepo = await initializeRepository(root, "public");
  await publishOrigin(privateRepo, "openclaw/grant-private");
  await publishOrigin(publicRepo, "openclaw/grant-public");
  stubRepositoryVisibility({
    "openclaw/grant-private": "private",
    "openclaw/grant-public": "public",
  });
  testState.agentConfig = { workspace, sandbox: { mode: "off" } };
  await createSessionStoreDir();
  const privateProject = await registerProjectRegistry({ path: privateRepo, name: "private" });
  const publicProject = await registerProjectRegistry({ path: publicRepo, name: "public" });
  const profile = ensureProfileForEmail("project-grant@example.test");
  const client = identifiedClient(profile.id);
  client.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
  const baseCfg = getRuntimeConfig();
  const makeConfig = (projects?: "*" | string[]) => ({
    ...baseCfg,
    gateway: {
      roles: {
        default: "guest",
        definitions: {
          guest: {
            scopes: ["operator.sessions.read" as const, "operator.sessions.write" as const],
            agents: ["main"],
            sessions: { others: "none" as const },
            ...(projects ? { projects } : {}),
          },
        },
      },
    },
  });
  // Each config edit is a new Gateway publication with its own session projection.
  let context!: ReturnType<typeof createDirectChatContext>;
  const useConfig = async (projects?: "*" | string[]) => {
    const cfg = makeConfig(projects);
    const next = createDirectChatContext({ getRuntimeConfig: () => cfg });
    next.readPreparedGatewayModelCatalog = async () => {
      const catalog = await next.loadGatewayModelCatalogSnapshot();
      return { entries: catalog.entries, routeVariants: catalog.routeVariants };
    };
    await initializeSessionReadContext(next);
    context = next;
  };
  await useConfig();
  const request = async (method: string, params: Record<string, unknown>) => {
    const respond = vi.fn();
    const req = { type: "req" as const, id: method, method, params };
    await handleGatewayRequest({ req, client, context, respond, isWebchatConnect: () => false });
    expect(respond).toHaveBeenCalledOnce();
    return respond.mock.calls[0]!;
  };
  const listed = async () => {
    const [ok, result, error] = await request("projects.list", {});
    expect(ok, JSON.stringify(error)).toBe(true);
    return (result as { projects: { id: string }[] }).projects.map((entry) => entry.id);
  };
  const create = (projectId: string) => request("sessions.create", { agentId: "main", projectId });
  const unknown = [
    false,
    undefined,
    { code: "INVALID_REQUEST", message: `unknown project id: ${privateProject.id}` },
  ];

  // Without a grant the public fallback is unchanged, including its direct checkout.
  expect(await listed()).toEqual(expect.arrayContaining([publicProject.id]));
  expect(await listed()).not.toContain(privateProject.id);
  expect(await create(privateProject.id)).toEqual(unknown);
  const [publicOk, publicSession, publicError] = await create(publicProject.id);
  expect(publicOk, JSON.stringify(publicError)).toBe(true);
  expect(publicSession).not.toHaveProperty("worktree");

  for (const projects of [[privateProject.id, "removed-project"], "*"] as const) {
    await useConfig(typeof projects === "string" ? projects : [...projects]);
    expect(await listed()).toEqual(expect.arrayContaining([privateProject.id, publicProject.id]));
    expect(
      await request("projects.checkoutOptions", { agentId: "main", projectId: privateProject.id }),
    ).toEqual([true, { current: false, worktree: true }, undefined]);
    // The client did not ask for a worktree; a grant-only project still gets one.
    const [ok, result, error] = await create(privateProject.id);
    expect(ok, JSON.stringify(error)).toBe(true);
    const { key, worktree } = expectDefined(result, "granted session") as {
      key: string;
      worktree: { id: string; path: string };
    };
    expect(await managedWorktrees.findLiveByOwner("session", key)).toMatchObject({
      id: worktree.id,
      repoRoot: privateRepo,
    });
    expect(worktree.path).not.toBe(privateRepo);
  }

  // Revocation applies to the next source handoff.
  await useConfig();
  expect(await create(privateProject.id)).toEqual(unknown);
  expect(await listed()).not.toContain(privateProject.id);
});
