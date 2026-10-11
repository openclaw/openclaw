import { onCleanup } from "solid-js";
import type {
  ControlUiLinkReaderDescriptor,
  ControlUiLinkReaderPreview,
} from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationContext } from "../app/context.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { HovercardOwner } from "./link-reader-hovercard-owner.ts";
import { EMPTY_LINK_READERS, LINK_READER_HOVERCARD_PROVIDER_TAG } from "./link-reader-target.ts";

export type HovercardProperties = {
  client: GatewayBrowserClient | null;
  agentId: string | undefined;
  readers: readonly ControlUiLinkReaderDescriptor[];
  previewSeeds: readonly ControlUiLinkReaderPreview[];
  pagePreviewContext: ApplicationContext | undefined;
  claimedReaders: readonly ControlUiLinkReaderDescriptor[];
};

type HovercardMethods = Pick<HovercardOwner, "activateFromBootstrap" | "prefetch">;
export type LinkReaderHovercardProvider = SolidBridgeElement<HovercardProperties, HovercardMethods>;

const properties = {
  client: { default: null, attribute: false },
  agentId: { default: undefined, attribute: false },
  readers: { default: EMPTY_LINK_READERS, attribute: false },
  previewSeeds: { default: [], attribute: false },
  pagePreviewContext: { default: undefined, attribute: false },
  claimedReaders: { default: EMPTY_LINK_READERS, attribute: false },
} as const;

const owners = new WeakMap<LinkReaderHovercardProvider, HovercardOwner>();

export const LinkReaderHovercard = defineSolidBridge<HovercardProperties, HovercardMethods>(
  LINK_READER_HOVERCARD_PROVIDER_TAG,
  (props, host) => {
    let owner = owners.get(host);
    if (!owner) {
      owner = new HovercardOwner(host, LinkReaderHovercardProvider);
      owners.set(host, owner);
      // Seed identity belongs to the host, and survives view remounts unchanged.
      for (const key of Object.keys(properties) as (keyof HovercardProperties)[]) {
        owner.propertyChanged(key);
      }
    }
    owner.connect();
    onCleanup(() => owner.disconnect());
    return props.children;
  },
  {
    properties,
    propertyChanged: (host, key) => owners.get(host)?.propertyChanged(key),
    methods: {
      activateFromBootstrap: (host, ...args) => owners.get(host)?.activateFromBootstrap(...args),
      prefetch: (host, ...args) =>
        owners.get(host)?.prefetch(...args) ??
        host.updateComplete.then(() => owners.get(host)?.prefetch(...args)),
    },
  },
);

export const LinkReaderHovercardProvider = customElements.get(
  LINK_READER_HOVERCARD_PROVIDER_TAG,
) as { new (): LinkReaderHovercardProvider };
