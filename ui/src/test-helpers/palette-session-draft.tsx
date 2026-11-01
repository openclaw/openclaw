import { createEffect, createMemo, createSignal, onSettled, Show } from "solid-js";
import { vi } from "vitest";
import { createChangeListeners } from "../../../src/shared/listeners.ts";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createDraftFixture } from "../pages/new-session/draft-submission-flow.test-support.ts";
import {
  PaletteSessionAttachments,
  PaletteSessionAuxiliary,
  PaletteSessionControls,
  PaletteSessionRecovery,
} from "../pages/new-session/palette-session-draft-view.tsx";
import { PaletteSessionDraft } from "../pages/new-session/palette-session-draft.ts";
import { mountSolid } from "./mount-solid.ts";
import { flush } from "./solid-settle.ts";

export class PaletteDraftHost {
  readonly element = document.createElement("div");
  readonly querySelector = this.element.querySelector.bind(this.element);
  readonly querySelectorAll = this.element.querySelectorAll.bind(this.element);
  private publish = () => {};
  private readonly onDraftChange = () => this.publish();
  private readonly unmount: () => void;
  paletteOpen = true;
  readonly started = vi.fn();
  readonly settingsReady = createDeferred();
  readonly coldOutcome = createDeferred();
  observeColdSubmission = false;
  private updated() {
    const remember = this.querySelector<HTMLInputElement>(
      ".palette-session-settings__remember input",
    );
    const worktree = this.querySelector<HTMLButtonElement>('[role="switch"]');
    if (remember && !remember.disabled && worktree && !worktree.disabled) {
      this.settingsReady.resolve();
    }
    if (this.observeColdSubmission && (!this.draft.messageLocked || this.draft.submitting)) {
      this.coldOutcome.resolve();
    }
  }
  readonly draft = new PaletteSessionDraft(
    this.element,
    () => ({ context: this.context, open: this.paletteOpen }),
    {
      changed: this.onDraftChange,
      updateComplete: () => this.updateComplete,
      onClose: () => this.started(),
    },
  );
  constructor(readonly context: ApplicationContext) {
    document.body.append(this.element);
    this.unmount = mountSolid(
      () => {
        const [revision, setRevision] = createSignal({}, { ownedWrite: true });
        this.publish = () => setRevision({});
        const recovery = createMemo(() => {
          revision();
          return this.draft.recoveryAction;
        });
        const message = createMemo(() => {
          revision();
          return this.draft.message;
        });
        createEffect(revision, () => {
          this.draft.synchronize();
          this.draft.settled();
          this.updated();
        });
        onSettled(() => {
          const sources = [context.agents, context.agentIdentity, context.sessions, context.config];
          const stops = sources.map((source) => source.subscribe(this.onDraftChange));
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
            <textarea aria-label="Palette prompt" value={message()} />
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
    ).unmount;
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

export async function mount(options: Parameters<typeof createDraftFixture>[0] = {}) {
  const fixture = createDraftFixture(options);
  const { context } = fixture;
  const changes = createChangeListeners();
  Object.assign(context.gateway, {
    connectionRevision: 1,
    subscribe: changes.subscribe,
  });
  Object.assign(context.agents.state, { connected: true, client: context.gateway.snapshot.client });
  Object.assign(context, {
    agentIdentity: {
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
      get: () => undefined,
    },
    navigate: vi.fn(),
  });
  Object.assign(context.placementStartup, { start: vi.fn() });
  const host = new PaletteDraftHost(context);
  host.draft.open();
  await host.updateComplete;
  await host.updateComplete;
  return { ...fixture, host, publish: changes.publish };
}
