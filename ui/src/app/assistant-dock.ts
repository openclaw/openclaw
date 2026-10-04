import type { ControlUiHost } from "../../../src/plugin-sdk/control-ui.js";
import { registerListener } from "../../../src/shared/listeners.js";

type SessionParams = Parameters<NonNullable<ControlUiHost["dock"]>["openSession"]>[0];

export type AssistantDockOwner = {
  openSession: (params: SessionParams, activation: object) => void;
  closeSession: (activation?: object) => void;
  readonly openSessionKey: string | null;
};

/** Application-local adapter. The mounted assistant panel owns all dock state. */
export class AssistantDock {
  private owner: AssistantDockOwner | undefined;
  private readonly listeners = new Set<() => void>();

  attach(owner: AssistantDockOwner): () => void {
    this.owner = owner;
    this.notify();
    return () => {
      if (this.owner === owner) {
        this.owner = undefined;
        this.notify();
      }
    };
  }

  openSession(params: SessionParams, activation: object): void {
    if (!this.owner) {
      throw new Error("The conversation dock is unavailable. Reopen the Control UI and try again.");
    }
    this.owner.openSession(params, activation);
  }

  close(activation?: object): void {
    this.owner?.closeSession(activation);
  }

  get openSessionKey(): string | null {
    return this.owner?.openSessionKey ?? null;
  }

  subscribe(listener: () => void): () => void {
    return registerListener(this.listeners, listener);
  }

  notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
