import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  call,
  dismissPendingTaskSuggestions,
  requirePayload,
  SOURCE_SESSION_KEY,
} from "./task-suggestions.test-support.js";
import type { RespondFn } from "./types.js";

const mocks = vi.hoisted(() => ({ handleChatSend: vi.fn() }));
vi.mock("./chat-send-handler.js", () => ({ handleChatSend: mocks.handleChatSend }));

const BASE_CWD = "/workspace";

beforeEach(async () => {
  await dismissPendingTaskSuggestions();
  mocks.handleChatSend.mockReset();
  mocks.handleChatSend.mockImplementation(async ({ respond }: { respond: RespondFn }) => {
    respond(true, { runId: "suggested-task-run", status: "started" }, undefined);
  });
});

afterEach(async () => {
  await dismissPendingTaskSuggestions();
  closeOpenClawAgentDatabasesForTest();
});

type SandboxConfigParams = {
  workspace: string;
  storePath: string;
  workspaceAccess?: "rw" | "none";
  workspaceRoot?: string;
  binds?: string[];
};

function sandboxedConfig(params: SandboxConfigParams) {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          backend: "docker",
          scope: "agent",
          ...(params.workspaceAccess ? { workspaceAccess: params.workspaceAccess } : {}),
          ...(params.workspaceRoot ? { workspaceRoot: params.workspaceRoot } : {}),
          ...(params.binds ? { docker: { binds: params.binds } } : {}),
        },
      },
      entries: { main: { workspace: params.workspace } },
    },
    session: { store: params.storePath },
  };
}

async function createSuggestion(params: { config: unknown; cwd: string }) {
  return await call(
    "taskSuggestions.create",
    {
      title: "Fix the sandbox follow-up",
      prompt: "Apply the focused fix flagged inside the sandbox.",
      tldr: "The follow-up was recorded from a sandboxed session.",
      cwd: params.cwd,
      sessionKey: SOURCE_SESSION_KEY,
      agentId: "main",
    },
    vi.fn(),
    { config: params.config as Record<string, unknown> },
  );
}

function requireSuggestion(result: Awaited<ReturnType<typeof createSuggestion>>) {
  const payload = requirePayload(result) as { taskId: string; suggestion: { cwd: string } };
  return payload;
}

describe("task suggestion host cwd for sandboxed sessions", () => {
  it("maps the container workspace path to the host workspace and accepts the card", async () => {
    await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
      const workspace = await fs.realpath(state.workspaceDir);
      const config = sandboxedConfig({
        workspace,
        storePath: state.statePath("agents", "{agentId}", "sessions", "sessions.json"),
        workspaceAccess: "rw",
      });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
        { sessionId: "follow-up-source", updatedAt: 1 },
      );

      const created = await createSuggestion({ config, cwd: BASE_CWD });
      const { taskId, suggestion } = requireSuggestion(created);
      expect(suggestion.cwd).toBe(workspace);

      const accepted = await call("taskSuggestions.accept", { taskId, mode: "local" }, vi.fn(), {
        config,
        context: {
          loadGatewayModelCatalog: async () => [],
          getSessionEventSubscriberConnIds: () => new Set(),
        },
      });
      expect(accepted.response?.[2]).toBeUndefined();
      const { key } = requirePayload(accepted) as { key: string };
      const entry = loadSessionEntry({ agentId: "main", sessionKey: key });
      expect(entry).toMatchObject({ spawnedCwd: workspace, parentSessionKey: SOURCE_SESSION_KEY });
    });
  });

  it("maps container subpaths onto the host sandbox workspace", async () => {
    await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
      const workspace = await fs.realpath(state.workspaceDir);
      await fs.mkdir(path.join(workspace, "nested", "project"), { recursive: true });
      const config = sandboxedConfig({
        workspace,
        storePath: state.statePath("agents", "{agentId}", "sessions", "sessions.json"),
        workspaceAccess: "rw",
      });

      const created = await createSuggestion({
        config,
        cwd: `${BASE_CWD}/nested/project`,
      });

      expect(requireSuggestion(created).suggestion.cwd).toBe(
        path.join(workspace, "nested", "project"),
      );
    });
  });

  it("maps to the session sandbox workspace when workspaceAccess does not admit the agent workspace", async () => {
    await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
      const workspace = await fs.realpath(state.workspaceDir);
      const workspaceRoot = state.statePath("sandboxes");
      const config = sandboxedConfig({
        workspace,
        storePath: state.statePath("agents", "{agentId}", "sessions", "sessions.json"),
        workspaceRoot,
      });

      const created = await createSuggestion({ config, cwd: BASE_CWD });
      const { cwd } = requireSuggestion(created).suggestion;

      expect(cwd.startsWith(`${workspaceRoot}${path.sep}`)).toBe(true);
      expect(cwd).not.toBe(workspace);
      expect((await fs.stat(cwd)).isDirectory()).toBe(true);
    });
  });

  it("keeps a container-only cwd acceptable in its source session", async () => {
    await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
      const workspace = await fs.realpath(state.workspaceDir);
      const config = sandboxedConfig({
        workspace,
        storePath: state.statePath("agents", "{agentId}", "sessions", "sessions.json"),
        workspaceAccess: "rw",
      });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
        { sessionId: "follow-up-source", updatedAt: 1 },
      );

      // The container owns this directory; the host sandbox workspace has no build/.
      const created = await createSuggestion({ config, cwd: `${BASE_CWD}/build` });
      const { taskId } = requireSuggestion(created);

      // Starting a host session still refuses a directory the host does not have.
      const refused = await call("taskSuggestions.accept", { taskId, mode: "local" }, vi.fn(), {
        config,
        context: {
          loadGatewayModelCatalog: async () => [],
          getSessionEventSubscriberConnIds: () => new Set(),
        },
      });
      expect(refused.response?.[0]).toBe(false);
      expect(refused.response?.[2]?.message).toContain("task suggestion cwd is unavailable");

      // "Start in this session" never needs a host cwd, so it still works.
      const accepted = await call("taskSuggestions.accept", { taskId, mode: "session" }, vi.fn(), {
        config,
      });
      const { key } = requirePayload(accepted) as { key: string };
      expect(key).toBe(SOURCE_SESSION_KEY);
      expect(mocks.handleChatSend).toHaveBeenCalledTimes(1);
    });
  });

  it("resolves container cwd against the source session's selected folder", async () => {
    await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
      const workspace = await fs.realpath(state.workspaceDir);
      const selected = state.path("selected-folder");
      await fs.mkdir(selected, { recursive: true });
      const config = sandboxedConfig({
        workspace,
        storePath: state.statePath("agents", "{agentId}", "sessions", "sessions.json"),
        workspaceAccess: "rw",
      });
      // Dashboard worktree sessions record the folder they were started in.
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
        { sessionId: "follow-up-source", updatedAt: 1, spawnedCwd: selected },
      );

      const created = await createSuggestion({ config, cwd: BASE_CWD });

      expect(requireSuggestion(created).suggestion.cwd).toBe(selected);
      expect(requireSuggestion(created).suggestion.cwd).not.toBe(workspace);
    });
  });

  it("resolves container cwd against a spawned session's inherited workspace", async () => {
    await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
      const workspace = await fs.realpath(state.workspaceDir);
      const inherited = state.path("inherited-workspace");
      await fs.mkdir(inherited, { recursive: true });
      const config = sandboxedConfig({
        workspace,
        storePath: state.statePath("agents", "{agentId}", "sessions", "sessions.json"),
        workspaceAccess: "rw",
      });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: SOURCE_SESSION_KEY },
        {
          sessionId: "follow-up-source",
          updatedAt: 1,
          spawnedBy: "agent:main:parent",
          spawnedWorkspaceDir: inherited,
        },
      );

      const created = await createSuggestion({ config, cwd: BASE_CWD });

      expect(requireSuggestion(created).suggestion.cwd).toBe(inherited);
      expect(requireSuggestion(created).suggestion.cwd).not.toBe(workspace);
    });
  });

  it("resolves a cwd covered by a nested bind mount to the bind host directory", async () => {
    await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
      const workspace = await fs.realpath(state.workspaceDir);
      const otherCheckout = state.path("other-checkout");
      await fs.mkdir(otherCheckout, { recursive: true });
      // The container path exists in the workspace mount too: the bind wins.
      await fs.mkdir(path.join(workspace, "project"), { recursive: true });
      const config = sandboxedConfig({
        workspace,
        storePath: state.statePath("agents", "{agentId}", "sessions", "sessions.json"),
        workspaceAccess: "rw",
        binds: [`${otherCheckout}:/workspace/project`],
      });

      const created = await createSuggestion({ config, cwd: `${BASE_CWD}/project` });

      expect(requireSuggestion(created).suggestion.cwd).toBe(path.resolve(otherCheckout));
      expect(requireSuggestion(created).suggestion.cwd).not.toBe(path.join(workspace, "project"));
    });
  });

  it("keeps a host workspace path unchanged for sandboxed sessions", async () => {
    await withOpenClawTestState({ scenario: "minimal", layout: "split" }, async (state) => {
      const workspace = await fs.realpath(state.workspaceDir);
      const config = sandboxedConfig({
        workspace,
        storePath: state.statePath("agents", "{agentId}", "sessions", "sessions.json"),
        workspaceAccess: "rw",
      });

      const created = await createSuggestion({ config, cwd: workspace });

      expect(requireSuggestion(created).suggestion.cwd).toBe(workspace);
    });
  });
});
