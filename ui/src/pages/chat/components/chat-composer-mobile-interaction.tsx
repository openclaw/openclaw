import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { containsComposed, registryFor } from "../../../components/overlay-registry.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import type { createChatComposerContext } from "./chat-composer-frame.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function createComposerMobileInteraction(
  context: () => ReturnType<typeof createChatComposerContext>,
  props: ChatComposerProps,
  state: ChatComposerState,
  shell: () => HTMLDivElement | undefined,
) {
  const [keyboardNavigation, setKeyboardNavigation] = createSignal(false);
  const editingScope = createMemo(() => context().draftKey);
  const mobileComposer = createMemo(() => props.mobileComposer === true);
  // Pane props refresh when the host consumes editing. Only changed scope/mode
  // values may reset this local interaction state, not that props invalidation.
  const [editing, setEditing] = createSignal(() => {
    editingScope();
    mobileComposer();
    return false;
  });
  const composerInput = () => state.composerInput;
  const ownedOverlay = (target: Node | null, ownerRoot = composerInput() ?? undefined) => {
    const doc = shell()?.ownerDocument;
    return doc
      ? registryFor(doc).stack.some((overlay) => {
          if (target && !overlay.contains(target)) {
            return false;
          }
          for (let owner: typeof overlay | undefined = overlay; owner; owner = owner.parent) {
            if (containsComposed(ownerRoot, owner.trigger ?? null)) {
              return true;
            }
          }
          return false;
        })
      : false;
  };

  const mobileEditing = createMemo(() => mobileComposer() && editing());
  const editingTransition = createMemo(
    () => ({
      editing: mobileEditing(),
      onChange: props.onComposerEditingChange,
    }),
    // Prepare current facts without republishing editing on unrelated prop updates.
    { equals: (previous, next) => previous.editing === next.editing },
  );
  const keyboardTransition = createMemo(() => ({ visible: props.mobileKeyboardVisible }), {
    equals: (previous, next) => previous.visible === next.visible,
  });
  let previousKeyboard: ReturnType<typeof keyboardTransition> | undefined;
  // Only these nonvisual lifetimes change; the composer DOM stays mounted.
  const lifecycle = (
    <>
      <Show when={editingTransition()} keyed>
        {(next) => {
          onSettled(() => {
            next.onChange?.(next.editing);
          });
          return undefined;
        }}
      </Show>
      <Show when={keyboardTransition()} keyed>
        {(next) => {
          onSettled(() => {
            const previous = previousKeyboard;
            previousKeyboard = next;
            if (previous?.visible === true && next.visible === false && !ownedOverlay(null)) {
              setEditing(false);
            }
          });
          return undefined;
        }}
      </Show>
    </>
  );
  onSettled(() => {
    const doc = shell()?.ownerDocument;
    if (!doc) {
      return undefined;
    }
    const insideEditor = (target: Node | null) =>
      containsComposed(composerInput() ?? undefined, target) || ownedOverlay(target);
    // Floating cards share the gesture surface without starting editor interaction.
    const insideComposer = (target: Node | null) =>
      containsComposed(shell(), target) ||
      // Collapsing on pointerdown would move Latest before its click can activate.
      containsComposed(props.getScrollToLatestElement?.() ?? undefined, target) ||
      ownedOverlay(target, shell());
    const editable = (target: Node | null) =>
      target instanceof Element &&
      target.matches(
        'textarea:not(:disabled):not([readonly]), input:not(:disabled):not([readonly]):is(:not([type]), [type="text"], [type="search"], [type="email"], [type="url"], [type="tel"], [type="password"], [type="number"]), [contenteditable="true"]',
      );
    let pointerOrigin: EventTarget | undefined;
    let disposed = false;
    const stops = [
      listen(
        doc,
        "pointerdown",
        (event) => {
          if (!props.mobileComposer) {
            return;
          }
          pointerOrigin = event.composedPath()[0];
          setKeyboardNavigation(false);
          // Focus during the tap.
          // iOS needs this user gesture to open the software keyboard.
          if (
            event.button === 0 &&
            pointerOrigin instanceof HTMLTextAreaElement &&
            pointerOrigin === state.composerTextarea &&
            editable(pointerOrigin)
          ) {
            pointerOrigin.focus({ preventScroll: true });
            setEditing(true);
          }
          if (pointerOrigin instanceof Node && !insideComposer(pointerOrigin)) {
            setEditing(false);
          }
        },
        true,
      ),
      listen(
        doc,
        "click",
        (event) => {
          // An editor-started pointer gesture belongs to the editor through commit.
          if (
            props.mobileComposer &&
            pointerOrigin === state.composerTextarea &&
            event.composedPath()[0] !== pointerOrigin &&
            event.detail > 0
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
          pointerOrigin = undefined;
        },
        true,
      ),
      listen(
        doc,
        "pointercancel",
        () => {
          pointerOrigin = undefined;
        },
        true,
      ),
      listen(
        doc,
        "focusin",
        (event) => {
          if (!props.mobileComposer) {
            return;
          }
          const target = event.composedPath()[0];
          if (!(target instanceof Node)) {
            return;
          }
          setKeyboardNavigation(pointerOrigin === undefined);
          if (insideEditor(target)) {
            if (editable(target)) {
              setEditing(true);
            }
          } else if (
            !insideComposer(target) &&
            !(pointerOrigin instanceof Node && insideComposer(pointerOrigin))
          ) {
            setEditing(false);
          }
        },
        true,
      ),
      listen(
        doc,
        "focusout",
        (event) => {
          // Picker focus can pass through the document before reaching its
          // control. Only an actual outside target ends editing; outside taps
          // are handled by pointerdown even when they have no focus target.
          const next = event.relatedTarget;
          if (!next || next === doc.body || next === doc.documentElement) {
            return;
          }
          if (next instanceof Node && insideComposer(next)) {
            return;
          }
          queueMicrotask(() => {
            if (
              !disposed &&
              props.mobileComposer &&
              !insideComposer(doc.activeElement) &&
              !ownedOverlay(null) &&
              !(pointerOrigin instanceof Node && insideComposer(pointerOrigin))
            ) {
              setEditing(false);
            }
          });
        },
        true,
      ),
    ];
    if (props.mobileComposer && insideEditor(doc.activeElement) && editable(doc.activeElement)) {
      setEditing(true);
    }
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
      props.onComposerEditingChange?.(false);
    };
  });
  return { mobileEditing, keyboardNavigation, lifecycle };
}
