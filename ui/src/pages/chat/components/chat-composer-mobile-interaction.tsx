import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { containsComposed, registryFor } from "../../../components/overlay-registry.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import type { createChatComposerContext } from "./chat-composer-frame.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function createComposerMobileInteraction(
  context: () => ReturnType<typeof createChatComposerContext>,
  props: ChatComposerProps,
  state: ChatComposerState,
  shell: () => HTMLDivElement | undefined,
  placeholder: () => HTMLSpanElement | undefined,
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

  let previousInputHeight: number | undefined;
  let inputReveals: Animation[] = [];
  const changeEditing = (next: boolean, previous = editing()) => {
    if (next !== previous) {
      previousInputHeight = state.composerInput?.getBoundingClientRect().height;
      inputReveals.forEach((animation) => animation.cancel());
      inputReveals = [];
    }
    setEditing(next);
  };
  const mobileEditing = createMemo(() => mobileComposer() && editing());
  const editingTransition = createMemo(
    () => ({
      editing: mobileEditing(),
      mobile: mobileComposer(),
      keyboardVisible: props.mobileKeyboardVisible,
      keyboardNavigation: keyboardNavigation(),
      onChange: props.onComposerEditingChange,
    }),
    // Prepare current facts without republishing editing on unrelated prop updates.
    { equals: (previous, next) => previous.editing === next.editing },
  );
  const keyboardTransition = createMemo(
    () => ({ visible: props.mobileKeyboardVisible, editing: editing() }),
    { equals: (previous, next) => previous.visible === next.visible },
  );
  let previousEditing: ReturnType<typeof editingTransition> | undefined;
  let previousKeyboard: ReturnType<typeof keyboardTransition> | undefined;
  // Only these nonvisual lifetimes change; the composer DOM and animation owner stay mounted.
  const lifecycle = (
    <>
      <Show when={editingTransition()} keyed>
        {(next) => {
          onSettled(() => {
            const previous = previousEditing;
            previousEditing = next;
            next.onChange?.(next.editing);
            const textarea = state.composerTextarea;
            if (textarea && (next.mobile || previous?.editing === true)) {
              adjustTextareaHeight(textarea);
            }
            const from = previousInputHeight;
            previousInputHeight = undefined;
            if (
              from !== undefined &&
              next.mobile &&
              !next.keyboardVisible &&
              !next.keyboardNavigation
            ) {
              queueMicrotask(() => {
                const input = state.composerInput;
                if (
                  !input?.isConnected ||
                  input.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)")
                    .matches
                ) {
                  return;
                }
                const to = input.getBoundingClientRect().height;
                inputReveals = [
                  input.animate(
                    [
                      { height: `${from}px`, minHeight: "0px", overflow: "clip" },
                      { height: `${to}px`, minHeight: "0px", overflow: "clip" },
                    ],
                    { duration: 180, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
                  ),
                ];
                // The compact hint and editor have different text origins. Reveal the
                // hint after the surface settles instead of carrying it through that jump.
                const hint = placeholder();
                if (hint) {
                  inputReveals.push(
                    hint.animate([{ opacity: 0 }, { opacity: 1 }], {
                      delay: 180,
                      duration: 80,
                      fill: "backwards",
                      easing: "ease-out",
                    }),
                  );
                }
              });
            }
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
              changeEditing(false, next.editing);
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
          // A tap on the editor starts writing even if a closing drawer or
          // keyboard transition prevents a new focusin event.
          if (
            event.button === 0 &&
            pointerOrigin instanceof Node &&
            pointerOrigin === state.composerTextarea &&
            editable(pointerOrigin)
          ) {
            changeEditing(true);
          }
          if (pointerOrigin instanceof Node && !insideComposer(pointerOrigin)) {
            changeEditing(false);
          }
        },
        true,
      ),
      listen(
        doc,
        "click",
        (event) => {
          // Expansion can move the toolbar under the first textarea tap. That tap
          // belongs to the editor, never to the action now occupying its position.
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
              changeEditing(true);
            }
          } else if (
            !insideComposer(target) &&
            !(pointerOrigin instanceof Node && insideComposer(pointerOrigin))
          ) {
            changeEditing(false);
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
              changeEditing(false);
            }
          });
        },
        true,
      ),
    ];
    if (props.mobileComposer && insideEditor(doc.activeElement) && editable(doc.activeElement)) {
      changeEditing(true);
    }
    return () => {
      disposed = true;
      inputReveals.forEach((animation) => animation.cancel());
      stops.forEach((stop) => stop());
      props.onComposerEditingChange?.(false);
    };
  });
  return { mobileEditing, keyboardNavigation, lifecycle };
}
