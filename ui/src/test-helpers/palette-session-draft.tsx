import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.ts";
import type { ApplicationContext } from "../app/context.ts";
import { ControllerHost } from "../lib/subscriptions-controller.ts";
import type { SolidController } from "../lit/solid-controller-host.ts";
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

export class PaletteDraftHost extends ControllerHost {
  readonly element = document.createElement("div");
  readonly ownerDocument = document;
  readonly querySelector = this.element.querySelector.bind(this.element);
  readonly querySelectorAll = this.element.querySelectorAll.bind(this.element);
  private readonly updatedControllers = new Set<SolidController>();
  private readonly unmount: () => void;
  readonly context: ApplicationContext;
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
    this,
    () => ({ context: this.context, open: this.paletteOpen }),
    { onClose: () => this.started() },
  );
  constructor(context: ApplicationContext) {
    super();
    this.context = context;
    document.body.append(this.element);
    const mounted = mountSolid(
      () => {
        const [revision, setRevision] = createSignal({}, { ownedWrite: true });
        const unsubscribe = this.subscribe(() => setRevision({}));
        const recovery = createMemo(() => {
          revision();
          return this.draft.recoveryAction;
        });
        const message = createMemo(() => {
          revision();
          return this.draft.message;
        });
        createEffect(revision, () => {
          for (const controller of this.updatedControllers) {
            controller.hostUpdated?.();
          }
          this.updated();
        });
        onCleanup(() => {
          unsubscribe();
          this.disconnect();
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
    );
    this.unmount = mounted.unmount;
    this.connect();
  }

  override addController(controller: SolidController) {
    this.updatedControllers.add(controller);
    super.addController(controller);
  }

  override removeController(controller: SolidController) {
    this.updatedControllers.delete(controller);
    super.removeController(controller);
  }

  override get updateComplete() {
    return super.updateComplete.then(() => {
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
  const listeners = new Set<() => void>();
  Object.assign(context.gateway, {
    connectionRevision: 1,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  Object.assign(context.agents, { subscribe: () => () => {} });
  Object.assign(context.agents.state, { connected: true, client: context.gateway.snapshot.client });
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
  Object.assign(context.placementStartup, { start: vi.fn() });
  const host = new PaletteDraftHost(context);
  host.draft.open();
  await host.updateComplete;
  await host.updateComplete;
  return { ...fixture, host, publish: () => listeners.forEach((listener) => listener()) };
}
