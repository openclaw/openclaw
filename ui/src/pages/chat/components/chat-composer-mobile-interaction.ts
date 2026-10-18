import { createEffect, createMemo, createSignal, onSettled, untrack } from "solid-js";
import { containsComposed, registryFor } from "../../../components/overlay-registry.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import type { createChatComposerContext } from "./chat-composer-frame.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";

export function createComposerMobileInteraction(
  context: () => ReturnType<typeof createChatComposerContext>,
  props: ChatComposerProps,
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
  const composerInput = () => context().state.composerInput;
  const ownedOverlay = (target: Node | null) => {
    const doc = shell()?.ownerDocument;
    return doc
      ? registryFor(doc).stack.some((overlay) => {
          if (target && !overlay.contains(target)) {
            return false;
          }
          for (let owner: typeof overlay | undefined = overlay; owner; owner = owner.parent) {
            if (containsComposed(composerInput() ?? undefined, owner.trigger ?? null)) {
              return true;
            }
          }
          return false;
        })
      : false;
  };

  let previousInputHeight: number | undefined;
  let inputReveals: Animation[] = [];
  const changeEditing = (next: boolean) => {
    if (next !== editing()) {
      previousInputHeight = context().state.composerInput?.getBoundingClientRect().height;
      inputReveals.forEach((animation) => animation.cancel());
      inputReveals = [];
    }
    setEditing(next);
  };
  const mobileEditing = createMemo(() => mobileComposer() && editing());
  createEffect(mobileEditing, (next, previous) =>
    untrack(() => {
      props.onComposerEditingChange?.(next);
      const textarea = context().state.composerTextarea;
      if (textarea && (props.mobileComposer || previous === true)) {
        adjustTextareaHeight(textarea);
      }
      const from = previousInputHeight;
      previousInputHeight = undefined;
      if (
        from !== undefined &&
        props.mobileComposer &&
        !props.mobileKeyboardVisible &&
        !keyboardNavigation()
      ) {
        queueMicrotask(() => {
          const input = context().state.composerInput;
          if (
            !input?.isConnected ||
            input.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches
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
          const placeholder = input.querySelector<HTMLElement>(".agent-chat__composer-placeholder");
          if (placeholder) {
            inputReveals.push(
              placeholder.animate([{ opacity: 0 }, { opacity: 1 }], {
                delay: 180,
                duration: 80,
                fill: "backwards",
                easing: "ease-out",
              }),
            );
          }
        });
      }
    }),
  );
  createEffect(
    () => props.mobileKeyboardVisible,
    (visible, previous) => {
      if (previous === true && visible === false) {
        untrack(() => {
          if (!ownedOverlay(null)) {
            changeEditing(false);
          }
        });
      }
    },
  );
  onSettled(() => {
    const doc = shell()?.ownerDocument;
    if (!doc) {
      return undefined;
    }
    const inside = (target: Node | null) =>
      containsComposed(composerInput() ?? undefined, target) || ownedOverlay(target);
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
          // Closing the keyboard may retain focus, so the next editor tap has
          // no focusin edge. Keep its origin before restoring the writing layout.
          if (
            event.button === 0 &&
            pointerOrigin instanceof Node &&
            pointerOrigin === context().state.composerTextarea &&
            doc.activeElement === pointerOrigin &&
            editable(pointerOrigin)
          ) {
            changeEditing(true);
          }
          if (pointerOrigin instanceof Node && !inside(pointerOrigin)) {
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
            pointerOrigin === context().state.composerTextarea &&
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
          if (inside(target)) {
            if (editable(target)) {
              changeEditing(true);
            }
          } else {
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
          if (next instanceof Node && inside(next)) {
            return;
          }
          queueMicrotask(() => {
            if (
              !disposed &&
              props.mobileComposer &&
              !inside(doc.activeElement) &&
              !ownedOverlay(null) &&
              !(pointerOrigin instanceof Node && inside(pointerOrigin))
            ) {
              changeEditing(false);
            }
          });
        },
        true,
      ),
    ];
    if (props.mobileComposer && inside(doc.activeElement) && editable(doc.activeElement)) {
      changeEditing(true);
    }
    return () => {
      disposed = true;
      inputReveals.forEach((animation) => animation.cancel());
      stops.forEach((stop) => stop());
      props.onComposerEditingChange?.(false);
    };
  });
  return { mobileEditing, keyboardNavigation };
}
