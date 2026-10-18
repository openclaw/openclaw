import { expectDefined } from "@openclaw/normalization-core";
import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, Show } from "solid-js";
import { vi } from "vitest";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import {
  getTranscriptState,
  type ChatThreadProps,
} from "../components/chat-thread-interactions.ts";
import { ChatThread } from "../components/chat-thread-view.tsx";
import type { ChatTranscript } from "../components/chat-transcript-controller.ts";
import { TranscriptSearch } from "../components/chat-transcript-search.tsx";
import type { ChatTranscriptSession } from "../components/chat-transcript-session.ts";
import {
  flushDeferredRowPrune,
  type TestContentRow,
} from "../components/chat-transcript.test-support.ts";

class ThreadFixture {
  constructor(
    readonly props: ChatThreadProps,
    readonly transcript: ChatTranscript,
    readonly search?: boolean,
  ) {}
}

class SearchFixture {
  constructor(readonly paneId: string) {}
}

type NativeContent = JSX.Element | ThreadFixture | SearchFixture;
const mounts = new WeakMap<HTMLElement, { update(value: NativeContent): void; unmount(): void }>();

function Content(props: { value: NativeContent }) {
  const thread = () => (props.value instanceof ThreadFixture ? props.value : undefined);
  const search = createMemo(() => {
    const value = props.value;
    if (value instanceof SearchFixture) {
      return value;
    }
    if (value instanceof ThreadFixture && value.search) {
      return new SearchFixture(value.props.paneId);
    }
    return undefined;
  });
  return (
    <>
      <Show when={search()}>
        {(value) => <TranscriptSearch search={getTranscriptState(value().paneId).search} />}
      </Show>
      <Show when={thread()}>
        {(value) => <ChatThread props={value().props} transcript={value().transcript} />}
      </Show>
      {props.value instanceof ThreadFixture || props.value instanceof SearchFixture
        ? undefined
        : props.value}
    </>
  );
}

export function renderChatThread(
  props: ChatThreadProps,
  transcript: ChatTranscript,
  options?: { search: boolean },
) {
  return new ThreadFixture(props, transcript, options?.search);
}

export function renderTranscriptSearch(paneId: string) {
  return new SearchFixture(paneId);
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

export class TranscriptTestHost extends HTMLElement {
  transcript?: ChatTranscript;
  readonly transcriptRoot = document.createElement("div");
  renderTranscript: () => NativeContent = () => null;
  committedRenders = 0;
  private pending: Promise<boolean> | undefined;
  private stopTranscript?: () => void;

  get updateComplete() {
    return this.pending ?? Promise.resolve(true);
  }

  connectedCallback() {
    this.append(this.transcriptRoot);
    this.stopTranscript = this.transcript?.subscribe(() => this.requestRender());
    this.transcript?.start();
    this.requestRender();
  }

  disconnectedCallback() {
    this.stopTranscript?.();
    this.stopTranscript = undefined;
    this.transcript?.dispose();
    queueMicrotask(() => {
      if (!this.isConnected) {
        render(null, this.transcriptRoot);
      }
    });
  }

  requestRender() {
    this.pending ??= Promise.resolve().then(() => {
      if (!this.isConnected) {
        this.pending = undefined;
        return true;
      }
      this.pending = undefined;
      render(this.renderTranscript(), this.transcriptRoot);
      this.committedRenders += 1;
      this.transcript?.update();
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
  transcript: ChatTranscript = createTestTranscript(paneId),
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
    transcript.update();
    flush();
  };
  transcript.start();
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

export function mcpRangeRows(appContent: JSX.Element): TestContentRow[] {
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
