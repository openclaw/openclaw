import type { ProgressCard } from "@openclaw/gateway-protocol";
import { createComponent, createSignal, merge } from "solid-js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import type { ChatDetailsSession } from "./chat-details-session.tsx";
import type { ChatDetailsProps } from "./chat-details-types.ts";
import { ChatDetails, type ChatDetailsViewProps } from "./chat-details.tsx";
import baseStyles from "../../../styles/base.css?inline";
import detailsStyles from "../../../styles/chat/details.css?inline";
import progressStyles from "../../../styles/chat/progress-card.css?inline";

/** One layout fixture implementation; callers own their mounted-node cleanup registry. */
export async function createDetailsBrowserFixture(
  value: ChatDetailsProps,
  mounted: HTMLElement[],
  width = 600,
  fullscreen = false,
  nativePresentation?: ChatDetailsViewProps["nativePresentation"],
  contentPending?: boolean,
  wrapper?: NonNullable<Parameters<typeof mountSolid>[1]>["wrapper"],
) {
  const styles = document.createElement("style");
  styles.textContent = [baseStyles, progressStyles, detailsStyles].join("\n");
  document.head.append(styles);
  const frame = document.createElement("div");
  frame.className = "chat-main__conversation-frame";
  frame.style.cssText = `position:relative;width:${width}px;height:560px;margin-left:20px`;
  const conversation = document.createElement("div");
  conversation.className = "chat-main__conversation";
  conversation.style.cssText =
    "position:absolute;inset-block:0;inset-inline-start:0;inset-inline-end:var(--chat-details-space,0px)";
  const footer = document.createElement("div");
  footer.className = "chat-footer";
  footer.style.cssText = "position:absolute;bottom:0;width:100%;height:100px";
  const pane = document.createElement("openclaw-chat-pane");
  pane.className = "sidebar-region";
  pane.style.cssText = `display:block;position:relative;width:${width}px;height:640px;margin:30px 20px`;
  pane.style.setProperty("--desktop-side-reserve", "0px");
  pane.style.setProperty("--desktop-divider-reserve", "0px");
  pane.append(frame);
  frame.hidden = fullscreen;
  const header = document.createElement("div");
  if (fullscreen) {
    pane.prepend(header);
  }
  document.body.append(pane);
  let details: ChatDetails | undefined;
  const [current, setCurrent] = createSignal<ChatDetailsViewProps>({
    chat: value,
    elements: { pane, frame, footer, header: fullscreen ? header : undefined },
    presentation: true,
    mobile: false,
    nativePresentation,
    contentPending,
    conversationVisible: !fullscreen,
    externalTrigger: fullscreen,
    setRef: (handle) => (details = handle),
  });
  const update = (patch: Partial<ChatDetailsViewProps>) =>
    setCurrent((previous) => ({ ...previous, ...patch }));
  const view = mountSolid(
    () =>
      createComponent(
        ChatDetails,
        merge(() => current()),
      ),
    { container: fullscreen ? header : frame, wrapper },
  );
  const element = view.container.querySelector("openclaw-chat-details")!;
  conversation.append(footer);
  frame.append(conversation);
  mounted.push(pane, styles);
  flush();
  const progress = pane.querySelector<HTMLElement>("openclaw-chat-details-progress")!;
  return {
    element,
    update,
    updateChat: (patch: Partial<ChatDetailsProps>) =>
      update({ chat: { ...current().chat!, ...patch } }),
    open: (source: HTMLElement) => details?.open(source),
    get controller() {
      return details;
    },
    frame,
    elements: current().elements!,
    pane,
    footer,
    get session() {
      return pane.querySelector<ChatDetailsSession>("openclaw-chat-details-session")!;
    },
    progress,
    conversation,
    panel: pane.querySelector<HTMLElement>(".chat-details")!,
    trigger: element.querySelector<HTMLButtonElement>(".chat-details-toggle")!,
  };
}

export const card: ProgressCard = {
  sessionKey: "agent:main:details",
  revision: 1,
  updatedAt: 1_000,
  steps: [
    { step: "Inspect layout", status: "completed" },
    { step: "Verify the change", status: "in_progress" },
  ],
};
export function detailsFixtureProps(overrides: Partial<ChatDetailsProps> = {}): ChatDetailsProps {
  return {
    sessionKey: card.sessionKey,
    currentAgentId: "main",
    selectedSession: { key: card.sessionKey, kind: "direct" },
    messages: [],
    gatewayScope: {},
    progressCard: card,
    progressCardLifetime: {},
    progressCardIdentity: card.sessionKey,
    detailsWorkspace: { root: "/workspace/details", label: "details" },
    ...overrides,
  };
}
