import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test.each(["all", "off"] as const)(
  "guest project checkout eligibility preserves creation admission (agent sandbox=%s)",
  async (mode) => {
    const root = tempDirs.make("openclaw-session-sandbox-project-");
    const workspace = await initializeRepository(root, "workspace");
    const outside = await initializeRepository(root, "outside");
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
        params: { agentId: "main", ...params },
      };
      await handleGatewayRequest({ req, client, context, respond, isWebchatConnect: () => false });
      expect(respond).toHaveBeenCalledOnce();
      return respond.mock.calls[0];
    };
    const expectOptions = async (projectId: string, current: boolean, worktree: boolean) => {
      const result = await request("projects.checkoutOptions", { projectId });
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
  },
);
