import { lazy, type ComponentProps } from "solid-js";
import { t } from "../../../lib/reactive/i18n.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";

const Details = lazy(() => import("./chat-ci-details.tsx"), { export: "ChatCiDetails" });
const Automation = lazy(() => import("./chat-ci-automation-control.tsx"), {
  export: "ChatCiAutomationControl",
});

export function ChatCiDetailsPanel(props: ComponentProps<typeof Details>) {
  return (
    <ChatLazyBoundary
      fallback={
        <div class="chat-ci__notice" role="status">
          {t("common.loading")}
        </div>
      }
    >
      <Details {...props} />
    </ChatLazyBoundary>
  );
}

export function ChatCiAutomationPanel(props: ComponentProps<typeof Automation>) {
  return (
    <ChatLazyBoundary
      fallback={
        <div class="chat-ci__notice" role="status">
          {t("common.loading")}
        </div>
      }
    >
      <Automation {...props} />
    </ChatLazyBoundary>
  );
}
