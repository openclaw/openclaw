import { expectDefined } from "@openclaw/normalization-core";
import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { vi } from "vitest";
import type { SolidController, SolidControllerHost } from "../../../lit/solid-controller-host.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import type { ChatThreadProps } from "../components/chat-thread-interactions.ts";
import { ChatThread } from "../components/chat-thread-view.tsx";
import type { ChatTranscriptController } from "../components/chat-transcript-controller.ts";
import type { ChatTranscriptSession } from "../components/chat-transcript-session.ts";
import {
  flushDeferredRowPrune,
  type TestContentRow,
} from "../components/chat-transcript.test-support.ts";

class ThreadFixture {
  constructor(
    readonly props: ChatThreadProps,
    readonly transcript: ChatTranscriptController,
  ) {}
}

type NativeContent = JSX.Element | ThreadFixture;
const mounts = new WeakMap<HTMLElement, { update(value: NativeContent): void; unmount(): void }>();

function Content(props: { value: NativeContent }) {
  const thread = () => (props.value instanceof ThreadFixture ? props.value : undefined);
  return (
    <>
      <Show when={thread()}>
        {(value) => <ChatThread props={value().props} transcript={value().transcript} />}
      </Show>
      {props.value instanceof ThreadFixture ? undefined : props.value}
    </>
  );
}

export function renderChatThread(props: ChatThreadProps, transcript: ChatTranscriptController) {
  return new ThreadFixture(props, transcript);
}

/** Retain native components between commits, including moves of session-owned row roots. */
export function render(value: NativeContent, container: HTMLElement): void {
  const existing = mounts.get(container);
  if (value == null) {
    existing?.unmount();
    mounts.delete(container);
    return;
  }
  if (existing) {
    existing.update(value);
  } else {
    let update!: (next: NativeContent) => void;
    const view = mountSolid(
      () => {
        const [content, setContent] = createSignal<NativeContent>(value);
        update = (next) => setContent(() => next);
        return <Content value={content()} />;
      },
      { container },
    );
    mounts.set(container, { update: (next) => update(next), unmount: view.unmount });
  }
  flush();
}

export class TranscriptTestHost extends HTMLElement implements SolidControllerHost {
  readonly transcriptRoot = document.createElement("div");
  renderTranscript: () => JSX.Element = () => null;
  committedRenders = 0;
  private readonly controllers = new Set<SolidController>();
  private pending: Promise<boolean> | undefined;

  addController(controller: SolidController) {
    this.controllers.add(controller);
  }
  removeController(controller: SolidController) {
    this.controllers.delete(controller);
  }
  get updateComplete() {
    return this.pending ?? Promise.resolve(true);
  }

  connectedCallback() {
    this.append(this.transcriptRoot);
    for (const controller of this.controllers) {
      controller.hostConnected?.();
    }
    this.requestUpdate();
  }

  disconnectedCallback() {
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
    render(null, this.transcriptRoot);
  }

  requestUpdate() {
    this.pending ??= Promise.resolve().then(() => {
      if (!this.isConnected) {
        this.pending = undefined;
        return true;
      }
      for (const controller of this.controllers) {
        controller.hostUpdate?.();
      }
      this.pending = undefined;
      render(this.renderTranscript(), this.transcriptRoot);
      this.committedRenders += 1;
      for (const controller of this.controllers) {
        controller.hostUpdated?.();
      }
      return true;
    });
  }

  async settleUpdates() {
    do {
      await this.updateComplete;
      flush();
    } while (this.pending);
  }
}

export async function mountTestTranscript(
  paneId: string,
  initialRows: readonly TestContentRow[],
  transcript = createTestTranscript(paneId),
) {
  const container = document.body.appendChild(document.createElement("div"));
  let currentSession: ChatTranscriptSession;
  container.addEventListener("focusin", (event) => currentSession.handleFocusIn(event));
  container.addEventListener("focusout", (event) => currentSession.handleFocusOut(event));
  const renderRows = (rows: readonly TestContentRow[]) => {
    render(
      transcript.renderSession(`agent:main:${paneId}`, (session) => {
        currentSession = session;
        return session.render(
          rows,
          (row) => (row.kind === "content" ? row.content : null),
          null,
          false,
        );
      }),
      container,
    );
    transcript.hostUpdated();
    flush();
  };
  transcript.hostConnected();
  renderRows(initialRows);
  await flushDeferredRowPrune();
  return {
    container,
    renderRows,
    transcript,
    get session() {
      return currentSession;
    },
  };
}

export function stubMcpAppLifecycle(
  container: ParentNode,
  teardown: () => Promise<void> = () => Promise.resolve(),
) {
  const app = expectDefined(
    container.querySelector<HTMLElement>("mcp-app-view"),
    "mounted MCP app",
  );
  const lifecycle = {
    restartAfterTeardown: vi.fn(),
    teardown: vi.fn(teardown),
  };
  return { app: Object.assign(app, lifecycle), ...lifecycle };
}

export function numberedContentRows(length: number): TestContentRow[] {
  return Array.from({ length }, (_, index) => ({
    kind: "content",
    key: `row:${index}`,
    content: <div>row {index}</div>,
  }));
}

export function mcpRangeRows(appContent: unknown): TestContentRow[] {
  return Array.from({ length: 24 }, (_, index) => ({
    kind: "content" as const,
    key: `row:${index}`,
    content: index === 23 ? appContent : <div>row {index}</div>,
  }));
}

export const contact = (identifier: number, target: EventTarget): Touch => ({
  identifier,
  target,
  clientX: 0,
  clientY: 100,
  pageX: 0,
  pageY: 100,
  screenX: 0,
  screenY: 100,
  radiusX: 1,
  radiusY: 1,
  rotationAngle: 0,
  force: 1,
});
