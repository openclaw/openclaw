import { expect } from "vitest";
import type {
  ControlUiLinkReaderDocument,
  ControlUiLinkReaderDescriptor,
} from "../../../src/shared/control-ui-link-reader.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid as waitForFast } from "../test-helpers/solid-settle.ts";
import { LINK_READER_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import "./link-reader-panel.tsx";

export type Panel = HTMLElementTagNameMap["openclaw-link-reader-panel"];
export const storageKey = "openclaw.link-reader.panel.v1";
export const itemUrl = (number: number) => "https://forge.example/items/" + number;
export const reader: ControlUiLinkReaderDescriptor = {
  pluginId: "forge",
  id: "items",
  label: "Forge",
  icon: "externalLink",
  linkReader: {
    hosts: ["forge.example"],
    pathPattern: "^/items/[1-9][0-9]*$",
    detailMethod: "forge.item",
  },
};
export function item(number = 1): ControlUiLinkReaderDocument {
  return {
    url: itemUrl(number),
    title: "Item " + number,
    author: "reporter",
    badge: { label: "Open", tone: "positive" },
    createdAt: "2026-09-01T12:00:00Z",
    updatedAt: "2026-09-02T12:00:00Z",
    body: "**Description**",
    comments: [
      {
        id: "comment-4",
        url: itemUrl(number) + "#comment-4",
        author: "reviewer",
        createdAt: "2026-09-02T12:00:00Z",
        body: "Comment text",
      },
    ],
    commentsTotal: 1,
  };
}
export function requestedItem(params: unknown): ControlUiLinkReaderDocument {
  return item(Number(new URL((params as { url: string }).url).pathname.split("/").at(-1)));
}

export function deferredDetail() {
  let resolve!: (value: ControlUiLinkReaderDocument) => void;
  const promise = new Promise<ControlUiLinkReaderDocument>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function mount(
  request: (
    method: string,
    params?: unknown,
    options?: { signal?: AbortSignal },
  ) => Promise<unknown>,
  options: Partial<
    Pick<Panel, "embedded" | "presented" | "sessionKey" | "tabsInHeader" | "onClose">
  > = {},
) {
  const panel = document.createElement("openclaw-link-reader-panel");
  panel.client = { request } as unknown as GatewayBrowserClient;
  panel.available = true;
  panel.readers = [reader];
  Object.assign(panel, options);
  mountSolid(() => panel);
  await panel.updateComplete;
  return panel;
}

export function open(panel: Panel, url = itemUrl(1), trigger?: HTMLElement, newTab = false) {
  panel.handleToggleRequest(
    new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
      detail: { url, open: true, trigger, newTab },
      cancelable: true,
    }),
  );
}

export function button(panel: Panel, label: string) {
  const result = panel.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]');
  if (!result) {
    throw new Error("Missing button: " + label);
  }
  return result;
}

export async function expectTitle(panel: Panel, title: string) {
  await waitForFast(() =>
    expect(panel.querySelector(".lr-content:not([hidden]) h1")?.textContent).toBe(title),
  );
}
