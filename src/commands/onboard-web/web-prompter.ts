/**
 * WebPrompter - Implements WizardPrompter interface for web-based UI.
 *
 * Communicates with the frontend via WebSocket messages.
 */

import type { WebSocket } from "ws";
import type {
  WizardPrompter,
  WizardSelectParams,
  WizardMultiSelectParams,
  WizardTextParams,
  WizardConfirmParams,
  WizardProgress,
} from "../../wizard/prompts.js";
import { WizardCancelledError } from "../../wizard/prompts.js";

type PromptType = "select" | "multiselect" | "text" | "confirm" | "note" | "intro" | "outro" | "progress";

interface PromptMessage {
  type: PromptType;
  id: string;
  params: unknown;
}

interface ResponseMessage {
  id: string;
  value: unknown;
  cancelled?: boolean;
}

let promptCounter = 0;

function generatePromptId(): string {
  return `prompt_${++promptCounter}_${Date.now()}`;
}

export class WebPrompter implements WizardPrompter {
  private ws: WebSocket;
  private pendingPrompts = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.setupCloseHandler();
  }

  private setupCloseHandler(): void {
    this.ws.on("close", () => {
      // Reject all pending prompts
      for (const [id, pending] of this.pendingPrompts) {
        pending.reject(new WizardCancelledError("Connection closed"));
        this.pendingPrompts.delete(id);
      }
    });
  }

  /**
   * Handle incoming response messages from the client.
   * Called by the server when a message is received.
   */
  handleMessage(message: ResponseMessage): void {
    const pending = this.pendingPrompts.get(message.id);

    if (pending) {
      this.pendingPrompts.delete(message.id);

      if (message.cancelled) {
        pending.reject(new WizardCancelledError());
      } else {
        pending.resolve(message.value);
      }
    }
  }

  private sendPrompt<T>(type: PromptType, params: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = generatePromptId();

      this.pendingPrompts.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });

      const message: PromptMessage = { type, id, params };
      this.ws.send(JSON.stringify(message));
    });
  }

  async intro(title: string): Promise<void> {
    await this.sendPrompt<void>("intro", { title });
  }

  async outro(message: string): Promise<void> {
    await this.sendPrompt<void>("outro", { message });
  }

  async note(message: string, title?: string): Promise<void> {
    await this.sendPrompt<void>("note", { message, title });
  }

  async select<T>(params: WizardSelectParams<T>): Promise<T> {
    return this.sendPrompt<T>("select", {
      message: params.message,
      options: params.options.map((opt) => ({
        value: opt.value,
        label: opt.label,
        hint: opt.hint,
      })),
      initialValue: params.initialValue,
    });
  }

  async multiselect<T>(params: WizardMultiSelectParams<T>): Promise<T[]> {
    return this.sendPrompt<T[]>("multiselect", {
      message: params.message,
      options: params.options.map((opt) => ({
        value: opt.value,
        label: opt.label,
        hint: opt.hint,
      })),
      initialValues: params.initialValues,
    });
  }

  async text(params: WizardTextParams): Promise<string> {
    return this.sendPrompt<string>("text", {
      message: params.message,
      initialValue: params.initialValue,
      placeholder: params.placeholder,
      // Note: validation will be done on the server side after receiving the response
    });
  }

  async confirm(params: WizardConfirmParams): Promise<boolean> {
    return this.sendPrompt<boolean>("confirm", {
      message: params.message,
      initialValue: params.initialValue,
    });
  }

  progress(label: string): WizardProgress {
    const id = generatePromptId();

    // Send initial progress message
    this.ws.send(JSON.stringify({
      type: "progress",
      id,
      params: { label, status: "start" },
    }));

    return {
      update: (message: string) => {
        this.ws.send(JSON.stringify({
          type: "progress",
          id,
          params: { label: message, status: "update" },
        }));
      },
      stop: (message?: string) => {
        this.ws.send(JSON.stringify({
          type: "progress",
          id,
          params: { label: message ?? label, status: "stop" },
        }));
      },
    };
  }
}
