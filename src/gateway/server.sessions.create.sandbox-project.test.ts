import fs from "node:fs/promises";
import path from "node:path";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  testState.agentConfig = undefined;
});
const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test("guest project-ID creation rejects direct access but admits its managed sandbox worktree", async () => {
  const root = tempDirs.make("openclaw-session-sandbox-project-");
  const workspace = await initializeRepository(root, "workspace");
  const outside = await initializeRepository(root, "outside");
  testState.agentConfig = { workspace, sandbox: { mode: "all" } };
  const { storePath } = await createSessionStoreDir();
  const project = await registerProjectRegistry({ path: outside });

  const profile = ensureProfileForEmail("project-guest@example.test");
  const client = identifiedClient(profile.id);
  client.connect.scopes = ["operator.sessions.read", "operator.sessions.write"];
  const cfg = {
    ...getRuntimeConfig(),
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
  const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
  context.readPreparedGatewayModelCatalog = async () => {
    const catalog = await context.loadGatewayModelCatalogSnapshot();
    return { entries: catalog.entries, routeVariants: catalog.routeVariants };
  };
  await initializeSessionReadContext(context);
  for (const worktree of [false, true]) {
    const respond = vi.fn();
    await handleGatewayRequest({
      req: {
        type: "req",
        id: `project-${worktree}`,
        method: "sessions.create",
        params: {
          agentId: "main",
          projectId: project.id,
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
    if (worktree) {
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
});
