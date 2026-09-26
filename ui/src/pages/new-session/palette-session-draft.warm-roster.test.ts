import { expectDefined } from "@openclaw/normalization-core";
import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { AgentsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import { PaletteSessionDraft } from "./palette-session-draft.ts";

class WarmRosterHost extends OpenClawLightDomElement {
  context: ApplicationContext | undefined;
  readonly placementReady = createDeferred();
  override updated() {
    if (this.querySelector(".palette-session-settings__workspace")) {
      this.placementReady.resolve();
    }
  }
  readonly draft = new PaletteSessionDraft(this, () => ({ context: this.context, open: true }), {
    onClose: () => undefined,
  });
  override render() {
    return html`${this.draft.renderControls()}${this.draft.renderRecovery()}`;
  }
}
customElements.define("test-palette-warm-roster", WarmRosterHost);

function roster(id: string, workspace: string): AgentsListResult {
  return {
    defaultId: id,
    mainKey: "main",
    scope: "per-sender",
    agents: [{ id, workspace, workspaceGit: false, model: { primary: "openai/gpt-5.5" } }],
  };
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("palette warm roster authority", () => {
  it.each([
    "untouched",
    "explicit-folder",
    "removed-agent",
    "refresh-failure",
    "missing-model",
  ] as const)(
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
      const cachedList = roster("main", "/workspace-a");
      if (choice === "missing-model") {
        cachedList.agents = cachedList.agents.map((agent) => ({ ...agent, model: undefined }));
      }
      const agents = createAgentCapability(context.gateway, {
        cachedList,
      });
      Object.assign(context, { agents });
      Object.assign(context.sessions, { subscribe: () => () => {} });
      Object.assign(context.config, { subscribe: () => () => {} });
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
      const host = document.createElement("test-palette-warm-roster") as WarmRosterHost;
      host.context = context;
      document.body.append(host);
      host.draft.open();
      await host.placementReady.promise;
      try {
        host.draft.setMessage("Keep this draft while defaults refresh");
        if (choice === "explicit-folder") {
          expectDefined(
            host.querySelector<HTMLButtonElement>(".palette-session-settings__workspace"),
            "workspace picker",
          ).click();
          await host.updateComplete;
          expectDefined(
            host.querySelector<HTMLButtonElement>('[data-machine="local"][data-project=""]'),
            "current workspace choice",
          ).click();
        }
        expect(host.draft.canSubmit).toBe(false);
        expect(host.draft.disabledReason).toBe("Refreshing agent defaults…");
        await host.draft.submit();
        expect(context.sessions.createResult).not.toHaveBeenCalled();

        const id = choice === "removed-agent" ? "replacement" : "main";
        if (choice === "refresh-failure") {
          fresh.reject(new Error("roster temporarily unavailable"));
          await read;
          await host.updateComplete;
          expect(host.draft.canSubmit).toBe(false);
          expect(host.draft.disabledReason).toBe(
            "Could not refresh agent defaults. Reload to try again.",
          );
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
        if (choice === "explicit-folder") {
          expect(params).toHaveProperty("cwd", "/workspace-a");
        } else {
          expect(params).not.toHaveProperty("cwd");
        }
      } finally {
        host.remove();
        agents.dispose();
      }
    },
  );
});
