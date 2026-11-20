import type { OpenClawCanvasWidgetView } from "../../../components/canvas-widget-view.tsx";
import type { BoardProvider } from "../../../lib/board/provider.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/canvas-embed-policy.ts";

export type WidgetCardOptions = {
  rawText?: string | null;
  toggleRawDetails?: () => boolean;
  canvasPluginSurfaceUrl?: string | null;
  mediaReadAllowed?: boolean;
  embedSandboxMode?: EmbedSandboxMode;
  allowExternalEmbedUrls?: boolean;
  sessionKey?: string;
  messageTimestamp?: number;
  boardProvider?: BoardProvider;
  widgetLayout?: import("../session-message-cache.ts").ChatWidgetLayout;
};

export type WidgetExportSource = HTMLIFrameElement | OpenClawCanvasWidgetView | undefined;
