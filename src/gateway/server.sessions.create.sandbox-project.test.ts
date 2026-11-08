import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { registerProjectRegistry } from "../projects/project-registry.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
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

// Keep the public API transport contract over this suite's stubbed fetch; the
// suite does not load the bundled GitHub provider transport.
vi.mock("./github-public-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-public-api.js")>()),
  gitHubPublicApi: {
    fetchGitHubJson: async (url: string, fetchImpl: typeof fetch) => {
      const response = await fetchImpl(url);
      if (!response.ok) {
        throw Object.assign(new Error("GitHub visibility lookup failed"), {
          statusCode: response.status,
        });
      }
      return await response.json();
    },
  },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
  vi.unstubAllGlobals();
});
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test.each(["all", "off"] as const)(
  "guest project checkout eligibility preserves creation admission (agent sandbox=%s)",
  async (mode) => {
    const root = tempDirs.make("openclaw-session-sandbox-project-");
    const workspace = await initializeRepository(root, "workspace");
    const outside = await initializeRepository(root, "outside");
    testState.agentConfig = { workspace, sandbox: { mode } };
    const { storePath } = await createSessionStoreDir();
    const repository = "example/sandbox-project-" + mode;
    const visibility = { current: "public" };
    const fetchImpl = vi.fn(async () => Response.json({ visibility: visibility.current }));
    vi.stubGlobal("fetch", fetchImpl);
    await promisify(execFile)("git", [
      "-C",
      outside,
      "remote",
      "set-url",
      "origin",
      "https://github.com/" + repository + ".git",
    ]);
    const project = await registerProjectRegistry({ path: outside });

    const profile = ensureProfileForEmail("project-guest@example.test");
    const client = identifiedClient(profile.id);
    client.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
    const baseCfg = getRuntimeConfig();
    const cfg = {
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
              sandbox: "required" as const,
            },
          },
        },
      },
    };
    let activeCfg: ReturnType<typeof getRuntimeConfig> = cfg;
    const context = createDirectChatContext({ getRuntimeConfig: () => activeCfg });
    context.readPreparedGatewayModelCatalog = async () => {
      const catalog = await context.loadGatewayModelCatalogSnapshot();
      return { entries: catalog.entries, routeVariants: catalog.routeVariants };
    };
    await initializeSessionReadContext(context);
    const checkoutOptions = async (projectId: string) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "checkout-options",
          method: "projects.checkoutOptions",
          params: { projectId, agentId: "main" },
        },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledOnce();
      return respond.mock.calls[0];
    };
    if (mode === "off") {
      activeCfg = {
        ...cfg,
        gateway: {
          roles: {
            ...cfg.gateway.roles,
            definitions: {
              guest: { ...cfg.gateway.roles.definitions.guest, sandbox: undefined },
            },
          },
        },
      };
      expect(await checkoutOptions(project.id)).toEqual([
        true,
        { current: true, worktree: true },
        undefined,
      ]);
      // A prior availability response grants nothing after the effective requirement changes.
      activeCfg = cfg;
    }
    expect(await checkoutOptions(project.id)).toEqual([
      true,
      { current: false, worktree: true },
      undefined,
    ]);
    expect(await checkoutOptions("workspace:main")).toEqual([
      true,
      { current: true, worktree: true },
      undefined,
    ]);
    expect(await checkoutOptions("workspace:other")).toEqual([
      true,
      { current: false, worktree: false },
      undefined,
    ]);
    for (const { projectId, worktree } of [
      { projectId: project.id, worktree: false },
      { projectId: project.id, worktree: true },
      { projectId: "workspace:other", worktree: true },
    ]) {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: `${projectId}-${worktree}`,
          method: "sessions.create",
          params: {
            agentId: "main",
            projectId,
            ...(worktree ? { worktree: true } : {}),
          },
        },
        client,
        context,
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledOnce();
      const [ok, result, error] = respond.mock.calls[0]!;
      const created = {
        ok,
        error,
        payload: result as
          | {
              key: string;
              worktree: { id: string; path: string; branch: string };
            }
          | undefined,
      };
      if (worktree && projectId === project.id) {
        expect(created.ok, JSON.stringify(created.error)).toBe(true);
        const payload = expectDefined(created.payload, "managed sandbox session payload");
        const record = await managedWorktrees.findLiveByOwner("session", payload.key);
        expect(record).toMatchObject({
          id: payload.worktree.id,
          path: payload.worktree.path,
          repoRoot: outside,
        });
        expect(payload.worktree.path).not.toBe(outside);
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: payload.key, storePath }),
        ).toMatchObject({
          worktree: { id: payload.worktree.id },
          createdActor: { type: "human", id: profile.id },
        });
        expect(await fs.readFile(path.join(payload.worktree.path, "README.md"), "utf8")).toBe(
          "outside\n",
        );
        continue;
      }
      expect(created).toMatchObject({
        ok: false,
        error: {
          code: "INVALID_REQUEST",
          message: "sessions.create project is outside the sandboxed agent workspace",
        },
      });
    }
    // Discovery's cached public answer cannot authorize a later source handoff.
    visibility.current = "private";
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: "private-project",
        method: "sessions.create",
        params: { agentId: "main", projectId: project.id, worktree: true },
      },
      client,
      context,
      respond,
      isWebchatConnect: () => false,
    });
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "unknown project id: " + project.id,
    });
    expect(await checkoutOptions(project.id)).toEqual([
      true,
      { current: false, worktree: false },
      undefined,
    ]);
    for (const [method, params] of [
      ["sessions.create", { projectGitUrl: "https://github.com/" + repository + ".git" }],
      ["projects.searchRemote", { query: repository }],
      ["worktrees.list", {}],
    ] as const) {
      const denied = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: method, method, params },
        client,
        context,
        respond: denied,
        isWebchatConnect: () => false,
      });
      expect(denied.mock.calls[0]?.[0]).toBe(false);
      expect(JSON.stringify(denied.mock.calls[0]?.[2])).toContain("operator.write");
    }
  },
);
