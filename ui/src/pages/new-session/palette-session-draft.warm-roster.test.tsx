import { createEffect, createMemo, createSignal, onSettled, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { AgentsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createAgentCapability } from "../../lib/agents/index.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { createDraftFixture } from "./draft-submission-flow.test-support.ts";
import {
  PaletteSessionAttachments,
  PaletteSessionAuxiliary,
  PaletteSessionControls,
  PaletteSessionRecovery,
} from "./palette-session-draft-view.tsx";
import { PaletteSessionDraft } from "./palette-session-draft.ts";

class WarmRosterHost {
  readonly element = document.createElement("div");
  readonly ownerDocument = document;
  readonly querySelector = this.element.querySelector.bind(this.element);
  readonly querySelectorAll = this.element.querySelectorAll.bind(this.element);
  private publish = () => {};
  private readonly onDraftChange = () => this.publish();
  private readonly unmount: () => void;
  readonly placementReady = createDeferred();
  readonly context: ApplicationContext;
  readonly draft = new PaletteSessionDraft(
    this.element,
    () => ({ context: this.context, open: true }),
    {
      changed: this.onDraftChange,
      updateComplete: () => this.updateComplete,
      onClose: () => undefined,
    },
  );

  constructor(context: ApplicationContext) {
    this.context = context;
    document.body.append(this.element);
    const mounted = mountSolid(
      () => {
        const [revision, setRevision] = createSignal({}, { ownedWrite: true });
        this.publish = () => setRevision({});
        const recovery = createMemo(() => {
          revision();
          return this.draft.recoveryAction;
        });
        createEffect(revision, () => {
          this.draft.synchronize();
          this.draft.settled();
          if (this.querySelector(".palette-session-settings__workspace")) {
            this.placementReady.resolve();
          }
        });
        onSettled(() => {
          const stops = [
            context.agents,
            context.agentIdentity,
            context.sessions,
            context.config,
          ].map((source) => source.subscribe(this.onDraftChange));
          this.draft.connect();
          this.onDraftChange();
          return () => {
            this.publish = () => {};
            stops.forEach((stop) => stop());
            this.draft.disconnect();
          };
        });
        return (
          <>
            <PaletteSessionControls draft={this.draft} revision={revision()} />
            <Show when={recovery()}>
              {(onOpen) => <PaletteSessionRecovery onOpen={onOpen()} />}
            </Show>
            <PaletteSessionAuxiliary draft={this.draft} revision={revision()} />
            <PaletteSessionAttachments draft={this.draft} revision={revision()} />
          </>
        );
      },
      { container: this.element },
    );
    this.unmount = mounted.unmount;
  }

  get updateComplete() {
    return Promise.resolve(true).then(() => {
      flush();
      return true;
    });
  }

  remove() {
    this.unmount();
    this.element.remove();
  }
}

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

describe("palette live roster authority", () => {
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
      const host = new WarmRosterHost(context);
      host.draft.open();
      await host.placementReady.promise;
      try {
        host.draft.setMessage("Keep this draft while defaults refresh");
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
        expect(params).not.toHaveProperty("cwd");
      } finally {
        host.remove();
        agents.dispose();
      }
    },
  );
});
