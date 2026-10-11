import { render, type JSX } from "@solidjs/web";
import {
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  runWithOwner,
  Show,
  Switch,
  untrack,
} from "solid-js";
import {
  PRESENTATION_CHANGED_EVENT,
  type PresentationBinding,
} from "../../../lit/presentation-binding.ts";
import { LitContent, SolidContentPresentation } from "../../../lit/solid-content.tsx";
import type { AfterCommitEffect } from "../render-lifecycle.ts";
import {
  createSolidRenderLifecycle,
  type SolidRenderLifecycle,
} from "../solid-render-lifecycle.ts";
import { ActivityGroup, MessageGroup } from "./chat-message-group-view.tsx";
import { StreamGroup, WorkGroupSummary } from "./chat-message-stream-view.tsx";
import type { TranscriptLayoutProps } from "./chat-transcript-layout.ts";
import { transcriptArraysEqual } from "./chat-transcript-memo.ts";
import {
  GuardedTranscriptItem,
  type NativeTranscriptView,
} from "./chat-transcript-render-guard.ts";

function NativeRow(props: { value: NativeTranscriptView }): JSX.Element {
  return (
    <Switch>
      <Match when={props.value.kind === "group" ? props.value : undefined}>
        {(view) => <MessageGroup group={view().group} options={view().options} />}
      </Match>
      <Match when={props.value.kind === "activity" ? props.value : undefined}>
        {(view) => (
          <ActivityGroup
            groups={view().groups}
            options={view().options}
            presentation={view().presentation}
          />
        )}
      </Match>
      <Match when={props.value.kind === "stream" ? props.value : undefined}>
        {(view) => <StreamGroup parts={view().parts} options={view().options} />}
      </Match>
      <Match when={props.value.kind === "work" ? props.value : undefined}>
        {(view) => <WorkGroupSummary item={view().item} options={view().options} />}
      </Match>
    </Switch>
  );
}

function GuardedRow(props: { value: GuardedTranscriptItem }): JSX.Element {
  const dependencies = createMemo(() => props.value.dependencies, {
    equals: transcriptArraysEqual,
  });
  const current = createMemo(() => {
    dependencies();
    return untrack(() => props.value);
  });
  return (
    <Show
      when={current().native}
      fallback={
        <Show when={current().legacy}>{(legacy) => <LitContent value={untrack(legacy())} />}</Show>
      }
    >
      {(view) => <NativeRow value={view()} />}
    </Show>
  );
}

function RowContent(props: { value: unknown }): JSX.Element {
  return (
    <Show
      when={props.value instanceof GuardedTranscriptItem ? props.value : undefined}
      fallback={<LitContent value={props.value} />}
    >
      {(item) => <GuardedRow value={item()} />}
    </Show>
  );
}

function TranscriptRows(props: { snapshot: TranscriptLayoutProps }) {
  const virtualRows = createMemo(() => {
    return props.snapshot.virtualizer.getVirtualItems();
  });
  return (
    <>
      <LitContent value={props.snapshot.header} />
      <div class="chat-virtual-sizer">
        <LitContent value={props.snapshot.overlay} />
        <div
          class="chat-virtual-block"
          style={{
            transform: `translateY(${(virtualRows()[0]?.start ?? props.snapshot.virtualizer.options.scrollMargin) - props.snapshot.virtualizer.options.scrollMargin}px)`,
          }}
        >
          <For each={virtualRows()} keyed={(row) => row.key}>
            {(virtualRow, renderedIndex) => {
              const index = createMemo(() => virtualRow().index);
              const row = createMemo(() => props.snapshot.rows[index()]);
              const content = createMemo(() => props.snapshot.getContent(index()));
              const gap = createMemo(() => {
                const previous = virtualRows()[renderedIndex() - 1];
                return previous && virtualRow().index > previous.index + 1
                  ? virtualRow().start - previous.end
                  : 0;
              });
              const measureRef = untrack(() =>
                props.snapshot.measureRowRefFor(String(virtualRow().key)),
              );
              onCleanup(() => measureRef(undefined));
              return (
                <>
                  <Show when={gap() > 0}>
                    <div aria-hidden="true" style={{ height: `${gap()}px` }} />
                  </Show>
                  <div
                    ref={(node) => measureRef(node)}
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

/** One Solid root per session; both legacy Lit and native callers retain this node. */
export class ChatTranscriptRenderer {
  private element?: HTMLDivElement;
  private accepted?: TranscriptLayoutProps;
  private committed?: TranscriptLayoutProps;
  private lifecycle?: SolidRenderLifecycle<TranscriptLayoutProps>;
  private publishPresentation?: () => void;
  private disposeRoot?: () => void;
  private binding?: PresentationBinding;
  private commitQueued = false;
  private readonly layoutEffects = new Set<() => void>();
  private readonly presentationChanged = () => this.publishPresentation?.();

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

  afterCommit(effect: AfterCommitEffect, onCancel?: () => void): () => void {
    if (!this.lifecycle) {
      onCancel?.();
      return () => {};
    }
    return this.lifecycle.afterCommit(effect, onCancel);
  }

  queueAfterLayout(effect: () => void): void {
    if (!this.lifecycle || this.layoutEffects.has(effect)) {
      return;
    }
    this.layoutEffects.add(effect);
    const release = () => {
      this.layoutEffects.delete(effect);
    };
    this.lifecycle.afterLayout(() => {
      release();
      effect();
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
        const current = untrack(() => this.lifecycle?.snapshot());
        if (!current || !this.element) {
          return;
        }
        this.committed = current;
        // Keep layout measurable, but do not paint the initial estimated range
        // before the session owner has placed it at the correct reading edge.
        this.element.style.visibility = current.initialPositionPending ? "hidden" : "";
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
      this.binding?.owner.removeEventListener(PRESENTATION_CHANGED_EVENT, this.presentationChanged);
      binding?.owner.addEventListener(PRESENTATION_CHANGED_EVENT, this.presentationChanged);
    }
    this.binding = binding;
    if (!this.element) {
      const element = document.createElement("div");
      element.className = "chat-thread-inner chat-thread-inner--virtual";
      this.element = element;
      // A session outlives the render computation that first introduces its DOM.
      this.disposeRoot = runWithOwner(null, () =>
        render(() => {
          const [presented, setPresented] = createSignal(this.isPresented(), { ownedWrite: true });
          this.publishPresentation = () => setPresented(this.isPresented());
          const active = () => presented() && this.isPresented();
          const lifecycle = createSolidRenderLifecycle({
            host: this,
            // The plain owner state also fences callbacks before the signal flushes.
            presented: active,
            read: () => {
              if (!this.accepted) {
                throw new Error("Transcript render snapshot was read after disposal");
              }
              return this.accepted;
            },
          });
          this.lifecycle = lifecycle;
          const snapshot = createMemo(lifecycle.snapshot);
          const capture = (event: Event) => snapshot().captureInteractionResize(event);
          element.addEventListener("click", capture, true);
          onCleanup(() => element.removeEventListener("click", capture, true));
          return (
            <SolidContentPresentation value={active}>
              <TranscriptRows snapshot={snapshot()} />
            </SolidContentPresentation>
          );
        }, element),
      );
    } else {
      this.publishPresentation?.();
    }
    if (this.commitQueued) {
      this.lifecycle?.invalidate();
    } else {
      this.commit();
    }
    next.scrollElementRef(this.element);
    return this.element;
  }

  dispose(): void {
    this.binding?.owner.removeEventListener(PRESENTATION_CHANGED_EVENT, this.presentationChanged);
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
  }
}
