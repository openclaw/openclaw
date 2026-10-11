import type {
  ControlUiLinkReaderDescriptor,
  ControlUiLinkReaderPreview,
} from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import type { SolidBridgeElement } from "../lit/solid-bridge.ts";
import type { HoverPreviewTarget, LinkReaderTarget } from "./link-reader-target.ts";

export type HovercardProperties = {
  client: GatewayBrowserClient | null;
  agentId: string | undefined;
  readers: readonly ControlUiLinkReaderDescriptor[];
  previewSeeds: readonly ControlUiLinkReaderPreview[];
  pagePreviewContext: ApplicationContext | undefined;
  claimedReaders: readonly ControlUiLinkReaderDescriptor[];
};

export type HovercardMethods = {
  activateFromBootstrap(
    anchor: HTMLAnchorElement,
    target: HoverPreviewTarget,
    trigger: "focus" | "pointer",
    delay: number,
  ): void;
  prefetch(target: LinkReaderTarget, signal: AbortSignal): Promise<void>;
};
export type LinkReaderHovercardProvider = SolidBridgeElement<HovercardProperties, HovercardMethods>;
