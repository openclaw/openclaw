import { createEffect, createSignal, onCleanup } from "solid-js";
import {
  PRESENTATION_CHANGED_EVENT,
  type PresentationBinding,
  type PresentationValue,
} from "../lit/presentation-binding.ts";
import { LinkReaderPrefetchOwner } from "./link-reader-prefetch-owner.ts";
import { MarkdownBlocks } from "./markdown-blocks-owner.ts";

export function linkReaderPrefetchRef(
  values: () => readonly [sessionKey: string, presented: PresentationValue, connected: boolean],
): (element: HTMLElement) => void {
  const [element, setElement] = createSignal<HTMLElement>();
  let root: HTMLElement | undefined;
  let mounted = true;
  let owner: LinkReaderPrefetchOwner | undefined;
  let binding: PresentationBinding | undefined;
  const presentationChanged = () => {
    if (binding?.isPresented() === false) {
      owner?.hide();
    }
  };
  createEffect(
    () => [element(), ...values()] as const,
    ([nextRoot, sessionKey, presented, connected]) => {
      if (root !== nextRoot) {
        owner?.disconnect();
        root = nextRoot;
        owner = root ? new LinkReaderPrefetchOwner(() => mounted) : undefined;
      }
      const nextBinding = typeof presented === "boolean" ? undefined : presented;
      if (binding?.owner !== nextBinding?.owner) {
        binding?.owner.removeEventListener(PRESENTATION_CHANGED_EVENT, presentationChanged);
        nextBinding?.owner.addEventListener(PRESENTATION_CHANGED_EVENT, presentationChanged);
      }
      binding = nextBinding;
      owner?.update(
        root,
        sessionKey,
        typeof presented === "boolean" ? presented : presented.isPresented(),
        connected,
      );
    },
  );
  onCleanup(() => {
    mounted = false;
    binding?.owner.removeEventListener(PRESENTATION_CHANGED_EVENT, presentationChanged);
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
  let binding: PresentationBinding | undefined;
  const presentationChanged = () => {
    if (binding?.isPresented() === false) {
      owner?.update(false);
    }
  };
  createEffect(
    () => [element(), presented()] as const,
    ([nextRoot, value]) => {
      if (root !== nextRoot) {
        owner?.dispose();
        root = nextRoot;
        owner = root ? new MarkdownBlocks(root) : undefined;
      }
      const nextBinding = typeof value === "boolean" ? undefined : value;
      if (binding?.owner !== nextBinding?.owner) {
        binding?.owner.removeEventListener(PRESENTATION_CHANGED_EVENT, presentationChanged);
        nextBinding?.owner.addEventListener(PRESENTATION_CHANGED_EVENT, presentationChanged);
      }
      binding = nextBinding;
      owner?.update(typeof value === "boolean" ? value : value.isPresented());
    },
  );
  onCleanup(() => {
    binding?.owner.removeEventListener(PRESENTATION_CHANGED_EVENT, presentationChanged);
    owner?.dispose();
  });
  return setElement;
}
