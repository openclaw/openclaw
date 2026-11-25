import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onSettled,
  useContext,
} from "solid-js";
import type { ChatDetailsProps } from "./chat-details-types.ts";

/** Only real sections and actionable errors contribute to the desktop Details control. */
export const DesktopDetailsContent = createContext<(() => () => void) | null>(null);

export function createDesktopDetailsContent(
  readChat: () => ChatDetailsProps | undefined,
  desktop: () => boolean,
  isPresented: () => boolean,
  wantsPanel: () => boolean,
  explicitlyClosed: () => boolean,
) {
  const [sections, setSections] = createSignal(0);
  const retainSection = () => {
    setSections((count) => count + 1);
    return () => setSections((count) => count - 1);
  };
  // These pane-owned facts already guarantee a row before the lazy sections mount.
  const knownContent = createMemo(() => {
    const chat = readChat();
    const cached = !chat?.sessionFactsReady && chat?.cachedDetails?.environment;
    return Boolean(
      chat?.progressCard ||
      chat?.progressCardError === "access-denied" ||
      (cached
        ? cached.worktree || cached.branch
        : chat?.selectedSession?.worktree || chat?.detailsWorkspace?.branch),
    );
  });
  const available = () => !desktop() || knownContent() || sections() > 0;
  // When pane facts cannot answer, keep the section owners observing independently of
  // their own results. Releasing a process read because it produced a row would erase it.
  const observeDesktop = () => desktop() && isPresented() && (wantsPanel() || !knownContent());
  const outputsDemand = createMemo(() => {
    const chat = readChat();
    return observeDesktop() && (!explicitlyClosed() || !available()) && chat?.outputs
      ? chat.retainOutputs
      : undefined;
  });
  return { retainSection, available, observeDesktop, outputsDemand };
}

// Hiding the last row or its trigger can move focus to body before layout settles.
export function createDetailsFocusRecovery<T>(
  available: () => boolean,
  presented: () => boolean,
  identity: () => T,
  ownsEvent: (event: Event) => boolean,
  restore: () => void,
) {
  let focused: T | undefined;
  createEffect(available, (hasContent, hadContent) => {
    if (!hasContent && hadContent && presented() && focused === identity()) {
      focused = undefined;
      restore();
    }
  });
  return (event: Event) => {
    const inside = ownsEvent(event);
    if (!inside) {
      focused = undefined;
    } else if (event.type === "focusin") {
      focused = identity();
    }
    return inside;
  };
}

export function ReportDesktopDetailsContent() {
  const retain = useContext(DesktopDetailsContent);
  if (retain) {
    onSettled(retain);
  }
  return null;
}
