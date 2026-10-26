import { expectDefined } from "@openclaw/normalization-core";
import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";
import { onTestFinished, vi } from "vitest";
import { registerMcpAppUnmountTarget } from "../../../components/mcp-app-unmount.ts";
import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { createTestTranscript } from "../chat-view.test-helpers.ts";
import {
  getTranscriptState,
  type ChatThreadProps,
} from "../components/chat-thread-interactions.ts";
import { ChatThread } from "../components/chat-thread-view.tsx";
import type { ChatTranscript } from "../components/chat-transcript-controller.ts";
import type { TranscriptRow } from "../components/chat-transcript-layout.ts";
import { TranscriptSearch } from "../components/chat-transcript-search.tsx";
import type { ChatTranscriptSession } from "../components/chat-transcript-session.ts";
import {
  flushDeferredRowPrune,
  type TestContentRow,
} from "../components/chat-transcript.test-support.ts";

class NativeFixture {
  constructor(
    readonly paneId: string,
    readonly search: boolean,
    readonly thread?: { props: ChatThreadProps; transcript: ChatTranscript },
  ) {}
}

type NativeContent = JSX.Element | NativeFixture;
const mounts = new WeakMap<HTMLElement, ReturnType<typeof mountSolid<{ value: NativeContent }>>>();
const rowContent = (row: TranscriptRow) => (row.kind === "content" ? row.content : null);

function Content(props: { value: NativeContent }) {
  const fixture = () => (props.value instanceof NativeFixture ? props.value : undefined);
  return (
    <>
      <Show when={fixture()?.search && fixture()}>
        {(value) => <TranscriptSearch search={getTranscriptState(value().paneId).search} />}
      </Show>
      <Show when={fixture()?.thread}>
        {(value) => <ChatThread props={value().props} transcript={value().transcript} />}
      </Show>
      {props.value instanceof NativeFixture ? undefined : props.value}
    </>
  );
}

export function renderChatThread(
  props: ChatThreadProps,
  transcript: ChatTranscript,
  options?: { search: boolean },
) {
  return new NativeFixture(props.paneId, options?.search ?? false, { props, transcript });
}

export function renderTranscriptSearch(paneId: string) {
  return new NativeFixture(paneId, true);
}

/** Retain native components between commits, including moves of session-owned row roots. */
export function render(value: NativeContent, container: HTMLElement): void {
  const transcript = value instanceof NativeFixture ? value.thread?.transcript : undefined;
  transcript?.start();
  const existing = mounts.get(container);
  if (value == null) {
    existing?.dispose();
    mounts.delete(container);
    return;
  }
  if (existing) {
    existing.update({ value });
  } else {
    mounts.set(container, mountSolid(Content, { value }, container));
  }
  transcript?.update();
}

export function mountChatThread(container: HTMLElement, transcript: ChatTranscript) {
  return {
    unmount: () => render(null, container),
    render(next: ChatThreadProps | null) {
      render(next ? renderChatThread({ ...next }, transcript) : null, container);
      flush();
    },
  };
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
      this.pending = undefined;
      if (this.isConnected) {
        render(this.renderTranscript(), this.transcriptRoot);
        this.committedRenders += 1;
        this.transcript?.update();
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
  transcript: ChatTranscript = createTestTranscript(paneId),
) {
  const container = document.body.appendChild(document.createElement("div"));
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: {
      configurable: true,
      get: () =>
        Number.parseFloat(
          container.querySelector<HTMLElement>(".chat-thread-inner")?.style.height ?? "0",
        ) || 0,
    },
  });
  container.scrollTo = (options?: ScrollToOptions | number) => {
    if (typeof options === "object") {
      const maximum = container.scrollHeight - container.clientHeight;
      container.scrollTop = Math.max(0, Math.min(options.top ?? container.scrollTop, maximum));
    }
  };
  let currentRows = initialRows;
  let renderQueued = false;
  let active = true;
  let currentSession: ChatTranscriptSession;
  container.addEventListener("focusin", (event) => currentSession.handleFocusIn(event));
  container.addEventListener("focusout", (event) => currentSession.handleFocusOut(event));
  const renderRows = (rows: readonly TestContentRow[]) => {
    currentRows = rows;
    currentSession = transcript.renderSession(`agent:main:${paneId}`, (session) => session);
    render(currentSession.render(rows, rowContent, null, false), container);
    transcript.update();
    flush();
  };
  const unsubscribe = transcript.subscribe(() => {
    if (!renderQueued) {
      renderQueued = true;
      queueMicrotask(() => {
        renderQueued = false;
        if (active) {
          renderRows(currentRows);
        }
      });
    }
  });
  onTestFinished(() => {
    active = false;
    unsubscribe();
  });
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
  const lifecycle = { restartAfterTeardown: vi.fn(), teardown: vi.fn(teardown) };
  const target = Object.assign(app, lifecycle);
  onTestFinished(registerMcpAppUnmountTarget(target));
  return { app: target, ...lifecycle };
}

export function numberedContentRows(
  length: number,
  content: (index: number) => JSX.Element = (index) => <div>row {index}</div>,
): TestContentRow[] {
  return Array.from({ length }, (_, index) => ({
    kind: "content",
    key: `row:${index}`,
    content: content(index),
  }));
}

export function mcpRangeRows(appContent: JSX.Element): TestContentRow[] {
  return numberedContentRows(24, (index) => (index === 23 ? appContent : <div>row {index}</div>));
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

export function renderReadyRows(session: ChatTranscriptSession, rows: readonly TranscriptRow[]) {
  session.setContentReady(true);
  return session.render(rows, rowContent, null, false);
}
