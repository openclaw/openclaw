import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  PRESENTATION_CHANGED_EVENT,
  type PresentationBinding,
  type PresentationValue,
} from "../lib/presentation.ts";
import { listen } from "../lib/reactive/listener.ts";
import { LinkReaderPrefetchOwner } from "./link-reader-prefetch-owner.ts";
import { MarkdownBlocks } from "./markdown-blocks-owner.ts";

function createPresentationReader(onHide: () => void) {
  let binding: PresentationBinding | undefined;
  let stop: (() => void) | undefined;
  const changed = () => {
    if (binding?.isPresented() === false) {
      onHide();
    }
  };
  onCleanup(() => stop?.());
  return (value: PresentationValue) => {
    const next = typeof value === "boolean" ? undefined : value;
    if (binding?.owner !== next?.owner) {
      stop?.();
      stop = next && listen(next.owner, PRESENTATION_CHANGED_EVENT, changed);
    }
    binding = next;
    return typeof value === "boolean" ? value : value.isPresented();
  };
}

export function linkReaderPrefetchRef(
  values: () => readonly [sessionKey: string, presented: PresentationValue, connected: boolean],
): (element: HTMLElement) => void {
  const [element, setElement] = createSignal<HTMLElement>();
  let root: HTMLElement | undefined;
  let mounted = true;
  let owner: LinkReaderPrefetchOwner | undefined;
  const readPresentation = createPresentationReader(() => owner?.hide());
  createEffect(
    () => [element(), ...values()] as const,
    ([nextRoot, sessionKey, presented, connected]) => {
      if (root !== nextRoot) {
        owner?.disconnect();
        root = nextRoot;
        owner = root ? new LinkReaderPrefetchOwner(() => mounted) : undefined;
      }
      const active = readPresentation(presented);
      owner?.update(root, sessionKey, active, connected);
    },
  );
  onCleanup(() => {
    mounted = false;
    owner?.disconnect();
  });
  return setElement;
}

export function markdownBlocksRef(
  presented: () => PresentationValue,
): (element: HTMLElement) => void {
  const [element, setElement] = createSignal<HTMLElement>();
  let root: HTMLElement | undefined;
  let owner: MarkdownBlocks | undefined;
  const readPresentation = createPresentationReader(() => owner?.update(false));
  createEffect(
    () => [element(), presented()] as const,
    ([nextRoot, value]) => {
      if (root !== nextRoot) {
        owner?.dispose();
        root = nextRoot;
        owner = root ? new MarkdownBlocks(root) : undefined;
      }
      const active = readPresentation(value);
      owner?.update(active);
    },
  );
  onCleanup(() => {
    owner?.dispose();
  });
  return setElement;
}
