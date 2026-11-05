import { lazy, Show } from "solid-js";
import { parseYouTubeVideoUrl } from "../../../lib/chat/youtube-video.ts";
import { ChatLazyBoundary } from "./chat-lazy-boundary.tsx";
import { widgetPreviewHeight } from "./widget-preview-layout.ts";

const Images = lazy(() => import("./chat-message-images-solid.tsx"), {
  export: "MessageImages",
});
const Attachments = lazy(() => import("./chat-message-attachments-solid.tsx"), {
  export: "AssistantAttachments",
});
const Attachment = lazy(() => import("./chat-message-attachments-solid.tsx"), {
  export: "MessageAttachment",
});
const Preview = lazy(() => import("./widget-card-view.tsx"), { export: "ToolPreview" });
const Recommendation = lazy(() => import("./chat-clawhub-card.tsx"), {
  export: "ChatClawHubCard",
});
const ForwardedSource = lazy(() => import("./chat-message-metadata-view.tsx"), {
  export: "ForwardedAttribution",
});
const WorkContext = lazy(() => import("./chat-message-metadata-view.tsx"), {
  export: "MessageWorkContext",
});
const AppContext = lazy(() => import("./chat-message-metadata-view.tsx"), {
  export: "SubmittedAppContext",
});

// Callers gate these views on the metadata actually present in the message.
export function ForwardedAttribution(
  props: Parameters<typeof import("./chat-forwarded-attribution.tsx").ForwardedAttribution>[0],
) {
  return (
    <ChatLazyBoundary
      fallback={
        <span
          class="chat-reply-attribution chat-reply-attribution--forwarded"
          style="height: 1lh;"
          aria-hidden="true"
        />
      }
    >
      <ForwardedSource {...props} />
    </ChatLazyBoundary>
  );
}

export function MessageWorkContext(
  props: Parameters<typeof import("./chat-message-context-view.tsx").MessageWorkContext>[0],
) {
  return (
    <ChatLazyBoundary
      fallback={
        <div class="chat-context-attachment" aria-hidden="true">
          <div class="chat-context-attachment__summary" />
        </div>
      }
    >
      <WorkContext {...props} />
    </ChatLazyBoundary>
  );
}

export function SubmittedAppContext(
  props: Parameters<typeof import("./submitted-app-context.tsx").SubmittedAppContext>[0],
) {
  return (
    <ChatLazyBoundary
      fallback={
        <div style="min-height: calc(1lh + 10px); margin-bottom: 8px;" aria-hidden="true" />
      }
    >
      <AppContext {...props} />
    </ChatLazyBoundary>
  );
}

// Pending New Session images use this adapter; transcript images render with the row.
// Empty collections keep deferred renderers and their players asleep.
export function MessageImages(
  props: Parameters<typeof import("./chat-message-images-solid.tsx").MessageImages>[0],
) {
  return (
    <Show when={props.images.length + (props.previews?.length ?? 0) > 0}>
      <ChatLazyBoundary>
        <Images {...props} />
      </ChatLazyBoundary>
    </Show>
  );
}

export function AssistantAttachments(
  props: Parameters<typeof import("./chat-message-attachments-solid.tsx").AssistantAttachments>[0],
) {
  return (
    <Show when={props.attachments.length > 0}>
      <ChatLazyBoundary>
        <Attachments {...props} />
      </ChatLazyBoundary>
    </Show>
  );
}

export function MessageAttachment(
  props: Parameters<typeof import("./chat-message-attachments-solid.tsx").MessageAttachment>[0],
) {
  return (
    <ChatLazyBoundary>
      <Attachment {...props} />
    </ChatLazyBoundary>
  );
}

export function ToolPreview(
  props: Parameters<typeof import("./widget-card-view.tsx").ToolPreview>[0],
) {
  return (
    <ChatLazyBoundary
      fallback={
        <Show
          when={
            props.preview?.kind === "canvas" &&
            props.preview.surface === "assistant_message" &&
            (props.options?.mediaReadAllowed === false ||
              props.preview.mcpApp ||
              !parseYouTubeVideoUrl(props.preview.url))
              ? props.preview
              : undefined
          }
        >
          {(preview) => (
            <div
              class="chat-tool-card__preview"
              aria-hidden="true"
              style={{
                "min-height": `${widgetPreviewHeight(preview(), props.options?.widgetLayout)}px`,
              }}
            />
          )}
        </Show>
      }
    >
      <Preview {...props} />
    </ChatLazyBoundary>
  );
}

export function ChatClawHubCard(
  props: Parameters<typeof import("./chat-clawhub-card.tsx").ChatClawHubCard>[0],
) {
  return (
    <ChatLazyBoundary>
      <Recommendation {...props} />
    </ChatLazyBoundary>
  );
}
