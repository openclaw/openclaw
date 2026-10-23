import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { AgentsListResult } from "../../api/types.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { PaletteDraftHost } from "../../test-helpers/palette-session-draft.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";

function roster(id: string, workspace: string): AgentsListResult {
  return {
    defaultId: id,
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id, workspace, workspaceGit: false, model: { primary: "openai/gpt-5.5" } }],
    sessionPlacement: {},
  };
}

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

it.each(["removed-agent", "refresh-failure"] as const)(
  "waits for current defaults and preserves %s intent in the create request",
  async (choice) => {
    const fresh = createDeferred<AgentsListResult>();
    const retry = createDeferred<AgentsListResult>();
    let requested = false;
    const { context } = createDraftFixture({
      request: (method) => {
        if (method === "environments.list") {
          return Promise.resolve({ profiles: [], environments: [] });
        }
        if (method !== "agents.list") {
          return Promise.resolve({ repositoryStatus: "not_git", branches: [] });
        }
        const result = requested ? retry.promise : fresh.promise;
        requested = true;
        return result;
      },
    });
    const agents = createAgentCapability(context.gateway);
    Object.assign(context, { agents });
    Object.assign(context, {
      agentIdentity: {
        subscribe: () => () => {},
        ensure: vi.fn(async () => {}),
        get: () => undefined,
      },
      navigate: vi.fn(),
    });
    vi.mocked(context.sessions.createResult).mockResolvedValue({
      key: "agent:main:dashboard:warm-roster",
      initialRun: { status: "idle" },
    });
    let read = agents.ensureList();
    const host = new PaletteDraftHost(context);
    host.draft.open();
    await waitForSolid(() =>
      expect(host.querySelector(".palette-session-settings__workspace")).not.toBeNull(),
    );
    try {
      host.draft.setMessage("Keep this draft while defaults refresh");
      expect(host.draft.canSubmit).toBe(false);
      expect(host.draft.disabledReason).toBe("Refreshing agent defaults…");
      expect(host.draft.error).toBeNull();
      await host.draft.submit();
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      expect(host.draft.error).toBeNull();

      const id = choice === "removed-agent" ? "replacement" : "main";
      if (choice === "refresh-failure") {
        fresh.reject(new Error("roster temporarily unavailable"));
        await read;
        await host.updateComplete;
        expect(host.draft.canSubmit).toBe(false);
        expect(host.draft.disabledReason).toBe(
          "Could not refresh agent defaults. Reload to try again.",
        );
        expect(host.draft.error).toBeNull();
        await host.draft.submit();
        expect(context.sessions.createResult).not.toHaveBeenCalled();
        read = agents.ensureList();
        retry.resolve(roster(id, "/workspace-b"));
      } else {
        fresh.resolve(roster(id, "/workspace-b"));
      }
      await read;
      await host.updateComplete;
      await host.updateComplete;
      expect(host.draft.message).toBe("Keep this draft while defaults refresh");
      expect(host.draft.canSubmit).toBe(true);
      await host.draft.submit();
      expect(context.sessions.createResult).toHaveBeenCalledOnce();
      const params = vi.mocked(context.sessions.createResult).mock.calls[0]?.[0];
      expect(params).toMatchObject({
        agentId: id,
        message: "Keep this draft while defaults refresh",
      });
      expect(params).not.toHaveProperty("cwd");
    } finally {
      host.remove();
      agents.dispose();
    }
  },
);
