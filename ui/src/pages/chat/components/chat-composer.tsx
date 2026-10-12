import { createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { solidTemplate } from "./chat-composer-controls.ts";
import { createChatComposerContext } from "./chat-composer-frame.ts";
import { getChatComposerState } from "./chat-composer-state.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";
import { renderChatComposerView } from "./chat-composer-view.tsx";

export { isChatRunWorking, resetChatComposerState } from "./chat-composer-state.ts";

type ChatComposerInput = ChatComposerProps & { renderRevision?: object };

function ChatComposer(props: ChatComposerInput) {
  const state = getChatComposerState(untrack(() => props.paneId));
  const [revision, setRevision] = createSignal(0);
  let inputDepth = 0;
  let inputInvalidated = false;
  let computingFrame = false;
  let deferredInvalidation = false;
  let disposed = false;
  const requestUpdate = () => {
    if (disposed) {
      return;
    }
    if (inputDepth > 0) {
      inputInvalidated = true;
      return;
    }
    if (computingFrame) {
      if (!deferredInvalidation) {
        deferredInvalidation = true;
        queueMicrotask(() => {
          deferredInvalidation = false;
          requestUpdate();
        });
      }
      return;
    }
    const notifyHost = untrack(() => props.onRequestUpdate);
    if (notifyHost) {
      notifyHost();
    } else {
      setRevision((value) => value + 1);
    }
  };
  const currentProps = new Proxy(props, {
    get: (target, key) => (key === "onRequestUpdate" ? requestUpdate : Reflect.get(target, key)),
  });
  const context = createMemo(() => {
    revision();
    // Lit owners can change local state without changing a prop's identity.
    void props.renderRevision;
    computingFrame = true;
    try {
      return createChatComposerContext(currentProps);
    } finally {
      computingFrame = false;
    }
  });
  onCleanup(() => {
    disposed = true;
    state.textareaRef?.();
    state.composerInputRef?.();
  });
  const fields = new Map(
    Object.keys(untrack(context)).map((key) => [
      key,
      createMemo(() => Reflect.get(context(), key), {
        equals: key === "state" || key === "dictation" ? false : undefined,
      }),
    ]),
  );
  const input =
    <E extends Event>(read: () => (event: E) => void) =>
    (event: E) => {
      inputDepth += 1;
      try {
        read()(event);
      } finally {
        inputDepth -= 1;
        if (inputDepth === 0 && inputInvalidated) {
          inputInvalidated = false;
          requestUpdate();
        }
      }
    };
  const handlers = {
    handleBeforeInput: input(() => context().handleBeforeInput),
    handleInput: input(() => context().handleInput),
    handleKeyDown: input(() => context().handleKeyDown),
    handleSelect: input(() => context().handleSelect),
    handleCompositionEnd: input(() => context().handleCompositionEnd),
    handleBlur: input(() => context().handleBlur),
  };
  return renderChatComposerView(
    // SAFETY: Every frame field is served by its projection; handlers are replaced explicitly.
    new Proxy({} as ReturnType<typeof createChatComposerContext>, {
      get: (_target, key) =>
        Object.hasOwn(handlers, key) ? Reflect.get(handlers, key) : fields.get(String(key))?.(),
    }),
  );
}

export function renderChatComposer(props: ChatComposerProps) {
  return solidTemplate(ChatComposer, { ...props, renderRevision: {} });
}
