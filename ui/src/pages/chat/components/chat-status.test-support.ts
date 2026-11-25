import { mountSolid } from "../../../test-helpers/solid-render.tsx";
import { ChatTypingIndicator } from "./chat-typing-indicator.tsx";

type TypingProps = Parameters<typeof ChatTypingIndicator>[0];
const typingViews = new WeakMap<HTMLElement, { update: (props: TypingProps) => void }>();

export function renderTypingIndicator(
  actors: TypingProps["actors"],
  container: HTMLElement,
  avatarPlacement?: TypingProps["avatarPlacement"],
  overflow?: TypingProps["overflow"],
) {
  const props: TypingProps = { actors, avatarPlacement, overflow };
  const view = typingViews.get(container);
  if (view) {
    view.update(props);
  } else {
    typingViews.set(container, mountSolid(ChatTypingIndicator, props, container));
  }
}
