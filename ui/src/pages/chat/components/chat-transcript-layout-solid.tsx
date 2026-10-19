import { dynamic, render, type JSX } from "@solidjs/web";
import { createMemo, createSignal, For, onCleanup, runWithOwner, Show, untrack } from "solid-js";
import { PRESENTATION_CHANGED_EVENT, type PresentationBinding } from "../../../lib/presentation.ts";
import { ApplicationProvider } from "../../../lib/reactive/context.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { ContentPresentation } from "../../../lib/solid/presentation.ts";
import type { AfterCommitEffect } from "../render-lifecycle.ts";
import {
  createSolidRenderLifecycle,
  type SolidRenderLifecycle,
} from "../solid-render-lifecycle.ts";
import { AgentRunFrame } from "./chat-agent-run-frame.tsx";
import { ChatDivider, ChatNotice } from "./chat-divider.tsx";
import { ChatHistoryBoundary } from "./chat-history-boundary.tsx";
import { ActivityGroup, MessageGroup } from "./chat-message-group-view.tsx";
import {
  StreamGroup,
  UnplacedSubagentWait,
  WorkGroupSummary,
} from "./chat-message-stream-view.tsx";
import { RealtimeTalkConversation } from "./chat-realtime-controls.tsx";
import { ChatSystemEvents } from "./chat-system-events.tsx";
import { TranscriptWorkPreviews } from "./chat-transcript-content.tsx";
import type { TranscriptContent, TranscriptLayoutProps } from "./chat-transcript-layout.ts";
import { TranscriptMediaDisconnect } from "./chat-transcript-media-lifecycle.ts";
import { transcriptArraysEqual } from "./chat-transcript-memo.ts";
import { TranscriptMessageElementsContext } from "./chat-transcript-message-elements.ts";
import {
  GuardedTranscriptItem,
  type NativeTranscriptView,
} from "./chat-transcript-render-guard.ts";
import { ChatTypingIndicator } from "./chat-typing-indicator.tsx";
import { TurnRecapRow } from "./chat-working-indicator.tsx";

const nativeRows = {
  "system-events": ChatSystemEvents,
  group: MessageGroup,
  activity: ActivityGroup,
  stream: StreamGroup,
  work: WorkGroupSummary,
  frame: AgentRunFrame,
  wait: UnplacedSubagentWait,
  divider: ChatDivider,
  notice: ChatNotice,
  "work-previews": TranscriptWorkPreviews,
  realtime: RealtimeTalkConversation,
  recap: TurnRecapRow,
  typing: ChatTypingIndicator,
};

function NativeRow(props: { value: NativeTranscriptView }): JSX.Element {
  const Row = dynamic(() => nativeRows[props.value.kind]);
  return <Row {...props.value} />;
}

function GuardedRow(props: { value: GuardedTranscriptItem }): JSX.Element {
  // Equal dependency vectors preserve the accepted row across unrelated stream updates.
  const current = createMemo(() => props.value, {
    equals: (before, next) => transcriptArraysEqual(before.dependencies, next.dependencies),
  });
  return <Show when={current().native}>{(view) => <NativeRow value={view()} />}</Show>;
}

function RowContent(props: { value: TranscriptContent }): JSX.Element {
  return (
    <Show
      when={props.value instanceof GuardedTranscriptItem ? props.value : undefined}
      fallback={props.value instanceof GuardedTranscriptItem ? null : props.value}
    >
      {(item) => <GuardedRow value={item()} />}
    </Show>
  );
}

function TranscriptRows(props: {
  snapshot: TranscriptLayoutProps;
  measureRowRefFor: TranscriptLayoutProps["measureRowRefFor"];
  columnRef: (element: HTMLDivElement) => void;
}) {
  const virtualRows = createMemo(() => {
    return props.snapshot.virtualizer.getVirtualItems();
  });
  return (
    <>
      <Show when={props.snapshot.header}>{(header) => <ChatHistoryBoundary {...header()} />}</Show>
      <div class="chat-virtual-sizer" ref={(element) => props.columnRef(element)}>
        {props.snapshot.overlay}
        <div
          class="chat-virtual-block"
          style={{
            transform: `translateY(${(virtualRows()[0]?.start ?? props.snapshot.virtualizer.options.scrollMargin) - props.snapshot.virtualizer.options.scrollMargin}px)`,
          }}
        >
          <For each={virtualRows()} keyed={(row) => row.key}>
            {(virtualRow, renderedIndex) => {
              const index = () => virtualRow().index;
              const row = () => props.snapshot.rows[index()];
              const content = createMemo(() => props.snapshot.getContent(index()));
              const gap = () => {
                const previous = virtualRows()[renderedIndex() - 1];
                return previous && virtualRow().index > previous.index + 1
                  ? virtualRow().start - previous.end
                  : 0;
              };
              // The keyed row owns one measurement binding for its entire mounted lifetime.
              const initialKey = untrack(() => String(virtualRow().key));
              const measureRef = props.measureRowRefFor(initialKey);
              onCleanup(() => measureRef(undefined));
              return (
                <>
                  <Show when={gap() > 0}>
                    <div aria-hidden="true" style={{ height: `${gap()}px` }} />
                  </Show>
                  <div
                    ref={measureRef}
                    class={[
                      "chat-virtual-row",
                      { "chat-virtual-row--first": virtualRow().index === 0 },
                    ]}
                    style={{ "contain-intrinsic-block-size": `${virtualRow().size}px` }}
                    data-index={String(virtualRow().index)}
                    data-virtual-row-key={row()?.key}
                  >
                    <RowContent value={content()} />
                  </div>
                </>
              );
            }}
          </For>
        </div>
      </div>
    </>
  );
}

/** One Solid root per session, independent of the caller's render computation. */
export class ChatTranscriptRenderer {
  private element?: HTMLDivElement;
  private column?: HTMLDivElement;
  private accepted?: TranscriptLayoutProps;
  private committed?: TranscriptLayoutProps;
  private lifecycle?: SolidRenderLifecycle<TranscriptLayoutProps>;
  private publishPresentation?: () => void;
  private disposeRoot?: () => void;
  private binding?: PresentationBinding;
  private stopPresentation?: () => void;
  private commitQueued = false;
  private readonly layoutEffects = new Set<() => void>();
  private readonly mediaDisconnect = new Set<() => void>();
  private publish?: () => void;
  private readonly presentationChanged = () => this.publishPresentation?.();

  get columnElement(): HTMLDivElement | undefined {
    return this.column;
  }

  subscribe(listener: () => void): () => void {
    this.publish = listener;
    return () => {
      this.publish = undefined;
    };
  }

  private isPresented(): boolean {
    const presented = this.accepted?.presented ?? false;
    return (
      this.element?.isConnected === true &&
      (typeof presented === "boolean" ? presented : presented.isPresented())
    );
  }

  connect(): void {
    this.publishPresentation?.();
  }

  disconnect(isConnected: () => boolean): void {
    for (const retire of this.mediaDisconnect) {
      retire();
    }
    // Moving a retained pane disconnects and reconnects within one task.
    queueMicrotask(() => {
      if (!isConnected()) {
        this.dispose();
      }
    });
  }

  afterCommit(effect: AfterCommitEffect, onCancel?: () => void): () => void {
    if (!this.lifecycle) {
      onCancel?.();
      return () => {};
    }
    return this.lifecycle.afterCommit(effect, onCancel);
  }

  syncInitialPosition(): void {
    if (this.element && this.accepted) {
      this.element.style.visibility = this.accepted.initialPositionPending() ? "hidden" : "";
    }
  }

  queueAfterCommit(effect: () => void): void {
    if (!this.lifecycle || this.layoutEffects.has(effect)) {
      return;
    }
    this.layoutEffects.add(effect);
    const release = () => {
      this.layoutEffects.delete(effect);
    };
    this.lifecycle.afterCommit(() => {
      // Nested row islands finish their commits before initial geometry is read.
      queueMicrotask(() => {
        release();
        if (this.isPresented()) {
          effect();
        }
      });
    }, release);
  }

  commit(): void {
    if (!this.lifecycle || this.commitQueued || this.accepted === this.committed) {
      return;
    }
    this.commitQueued = true;
    this.lifecycle.afterCommit(
      () => {
        this.commitQueued = false;
        const current = this.lifecycle?.snapshot();
        if (!current || !this.element) {
          return;
        }
        this.committed = current;
        // Keep layout measurable, but do not paint the initial estimated range
        // before the session owner has placed it at the correct reading edge.
        this.syncInitialPosition();
        this.element.toggleAttribute("data-measuring-rows", current.measureRows);
        current.layout.commitRange(
          this.element,
          current.virtualizer.getTotalSize() + current.headerHeight,
        );
        current.onCommit();
      },
      () => {
        this.commitQueued = false;
      },
    );
  }

  render(next: TranscriptLayoutProps): HTMLDivElement {
    this.accepted = next;
    const binding = typeof next.presented === "boolean" ? undefined : next.presented;
    if (binding?.owner !== this.binding?.owner) {
      this.stopPresentation?.();
      this.stopPresentation = binding
        ? listen(binding.owner, PRESENTATION_CHANGED_EVENT, this.presentationChanged)
        : undefined;
    }
    this.binding = binding;
    if (!this.element) {
      const element = document.createElement("div");
      element.className = "chat-thread-inner chat-thread-inner--virtual";
      element.style.visibility = next.initialPositionPending() ? "hidden" : "";
      this.element = element;
      // This retained transcript island outlives the computation that introduces its DOM.
      // Its session owner disposes the detached root, including while the pane is parked.
      this.disposeRoot = runWithOwner(null, () =>
        render(() => {
          const [presented, setPresented] = createSignal(this.isPresented(), { ownedWrite: true });
          this.publishPresentation = () => setPresented(this.isPresented());
          const active = () => presented() && this.isPresented();
          const source = projectOwner(this, (owner) => {
            if (!owner.accepted) {
              throw new Error("Transcript render snapshot was read after disposal");
            }
            return owner.accepted;
          });
          const lifecycle = createSolidRenderLifecycle({
            host: this,
            // The plain owner state also fences callbacks before the signal flushes.
            presented: active,
            read: source.read,
          });
          this.lifecycle = lifecycle;
          const snapshot = createMemo(lifecycle.snapshot);
          const capture = (event: Event) => snapshot().captureInteractionResize(event);
          onCleanup(listen(element, "click", capture, true));
          const content = () => (
            <TranscriptMessageElementsContext value={next.messageElements}>
              <TranscriptMediaDisconnect value={this.mediaDisconnect}>
                <ContentPresentation value={active}>
                  <TranscriptRows
                    snapshot={snapshot()}
                    measureRowRefFor={next.measureRowRefFor}
                    columnRef={(column) => {
                      this.column = column;
                    }}
                  />
                </ContentPresentation>
              </TranscriptMediaDisconnect>
            </TranscriptMessageElementsContext>
          );
          // Keep the session root independent while retaining its application capabilities.
          return (
            <Show when={snapshot().applicationContext} fallback={content()} keyed>
              {(application) => (
                <ApplicationProvider value={application}>{content()}</ApplicationProvider>
              )}
            </Show>
          );
        }, element),
      );
    } else {
      this.publishPresentation?.();
      this.publish?.();
    }
    this.commit();
    next.scrollElementRef(this.element);
    return this.element;
  }

  dispose(): void {
    this.stopPresentation?.();
    this.stopPresentation = undefined;
    this.binding = undefined;
    this.disposeRoot?.();
    this.disposeRoot = undefined;
    this.publishPresentation = undefined;
    this.lifecycle = undefined;
    this.accepted = undefined;
    this.committed = undefined;
    this.commitQueued = false;
    this.layoutEffects.clear();
    this.element = undefined;
    this.column = undefined;
  }
}
