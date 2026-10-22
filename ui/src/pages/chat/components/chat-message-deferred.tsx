import { lazy, Loading, Show } from "solid-js";

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

// Chat and pending New Session messages share these boundaries. Empty media
// collections must not load the renderers or the players they register.
export function MessageImages(
  props: Parameters<typeof import("./chat-message-images-solid.tsx").MessageImages>[0],
) {
  return (
    <Show when={props.images.length + (props.previews?.length ?? 0) > 0}>
      <Loading>
        <Images {...props} />
      </Loading>
    </Show>
  );
}

export function AssistantAttachments(
  props: Parameters<typeof import("./chat-message-attachments-solid.tsx").AssistantAttachments>[0],
) {
  return (
    <Show when={props.attachments.length > 0}>
      <Loading>
        <Attachments {...props} />
      </Loading>
    </Show>
  );
}

export function MessageAttachment(
  props: Parameters<typeof import("./chat-message-attachments-solid.tsx").MessageAttachment>[0],
) {
  return (
    <Loading>
      <Attachment {...props} />
    </Loading>
  );
}

export function ToolPreview(
  props: Parameters<typeof import("./widget-card-view.tsx").ToolPreview>[0],
) {
  return (
    <Loading>
      <Preview {...props} />
    </Loading>
  );
}

export function ChatClawHubCard(
  props: Parameters<typeof import("./chat-clawhub-card.tsx").ChatClawHubCard>[0],
) {
  return (
    <Loading>
      <Recommendation {...props} />
    </Loading>
  );
}
