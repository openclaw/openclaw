/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { LinkReaderHovercardProvider } from "./link-reader-hovercard.ts";
import { LINK_READER_PANEL_TOGGLE_EVENT } from "./panel-toggle-contract.ts";
import "./link-reader-panel.tsx";

const tag = "test-reader-metadata-" + crypto.randomUUID();
customElements.define(tag, class extends LinkReaderHovercardProvider {});
const url = "https://github.com/openclaw/openclaw/pull/99816";
const reader = {
  pluginId: "github",
  id: "items",
  label: "GitHub",
  linkReader: {
    hosts: ["github.com"],
    pathPattern: "^/[^/]+/[^/]+/pull/[0-9]+$",
    previewMethod: "github.preview",
    detailMethod: "github.detail",
  },
};
const open: ControlUiLinkReaderDocument = {
  url,
  title: "Keep PR status current",
  body: "Description",
  badge: { label: "Open", tone: "positive" },
  metadata: [{ label: "", value: "+42" }],
  coAuthors: [{ name: "reviewer" }],
  coAuthorCount: 1,
};
const merged: ControlUiLinkReaderDocument = {
  ...open,
  badge: { label: "Merged", tone: "accent" },
  metadata: [{ label: "Additions", value: "42" }],
};
function makeProvider() {
  const host = document.createElement(tag);
  if (!(host instanceof LinkReaderHovercardProvider)) {
    throw new Error("Missing reader bridge");
  }
  host.readers = [reader];
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.className = "markdown-github-item";
  anchor.textContent = "PR #99816";
  host.append(anchor);
  document.body.append(host);
  return { host, anchor };
}
async function hover(anchor: HTMLAnchorElement) {
  await Promise.resolve();
  anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(250);
}
const badge = () => document.querySelector(".link-reader-hovercard__state")?.textContent?.trim();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", createStorageMock());
  vi.spyOn(GatewayBrowserClient.prototype, "connected", "get").mockReturnValue(true);
});
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(["same", "other-client", "other-agent", "other-session"])(
  "reconciles detail metadata only in the matching %s scope",
  async (scope) => {
    const request = vi.fn((method: string) =>
      Promise.resolve(method === "github.detail" ? merged : open),
    );
    const client = createTestGatewayClient(request);
    const { host, anchor } = makeProvider();
    host.client = client;
    host.agentId = "main";
    host.sessionKey = "agent:main:pane-one";
    await hover(anchor);
    expect(badge()).toBe("Open");
    const panel = document.createElement("openclaw-link-reader-panel");
    panel.client = scope === "other-client" ? createTestGatewayClient(request) : client;
    panel.agentId = scope === "other-agent" ? "other" : "main";
    panel.sessionKey = scope === "other-session" ? "agent:main:pane-two" : "agent:main:pane-one";
    panel.available = true;
    panel.readers = [reader];
    mountSolid(() => panel);
    await panel.updateComplete;
    panel.handleToggleRequest(
      new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
        detail: { url, open: true },
        cancelable: true,
      }),
    );
    await waitForSolid(() =>
      expect(panel.querySelector(".lr-state")?.textContent).toContain("Merged"),
    );
    expect(badge()).toBe(scope === "same" ? "Merged" : "Open");
    anchor.dispatchEvent(
      new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    );
    await vi.advanceTimersByTimeAsync(120);
    await hover(anchor);
    expect(badge()).toBe(scope === "same" ? "Merged" : "Open");
    expect(document.querySelector(".link-reader-hovercard__metadata")?.textContent).toBe("+42");
    expect(request.mock.calls.filter(([method]) => method === "github.preview")).toHaveLength(1);
  },
);

it.each([false, true])(
  "refreshes an explicitly stale response once (session scoped: %s)",
  async (sessionScoped) => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...open, stale: true })
      .mockResolvedValue(merged);
    const { host, anchor } = makeProvider();
    host.client = createTestGatewayClient(request);
    host.sessionKey = "agent:main:pane-one";
    host.readers = [{ ...reader, linkReader: { ...reader.linkReader, sessionScoped } }];
    await hover(anchor);
    expect(badge()).toBe("Merged");
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual({
      url,
      refresh: true,
      ...(sessionScoped ? { sessionKey: "agent:main:pane-one" } : {}),
    });
  },
);

it("labels still-stale metadata and retries only after short backoff", async () => {
  const request = vi.fn().mockResolvedValue({ ...open, stale: true });
  const { host, anchor } = makeProvider();
  host.client = createTestGatewayClient(request);
  await hover(anchor);
  expect(badge()).toBe("Open");
  expect(document.querySelector<HTMLElement>(".link-reader-hovercard")?.dataset.cached).toBe(
    "true",
  );
  expect(request).toHaveBeenCalledTimes(2);
  anchor.dispatchEvent(
    new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
  );
  await vi.advanceTimersByTimeAsync(120);
  await hover(anchor);
  expect(request).toHaveBeenCalledTimes(2);
  anchor.dispatchEvent(
    new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
  );
  await vi.advanceTimersByTimeAsync(30_000);
  await hover(anchor);
  expect(request).toHaveBeenCalledTimes(4);
});

it("does not let an older pending preview overwrite committed reader details", async () => {
  const pending = Promise.withResolvers<ControlUiLinkReaderDocument>();
  const request = vi.fn((method: string) =>
    method === "github.detail" ? Promise.resolve(merged) : pending.promise,
  );
  const client = createTestGatewayClient(request);
  const { host, anchor } = makeProvider();
  host.client = client;
  await hover(anchor);
  const panel = document.createElement("openclaw-link-reader-panel");
  panel.client = client;
  panel.available = true;
  panel.readers = [reader];
  mountSolid(() => panel);
  await panel.updateComplete;
  panel.handleToggleRequest(
    new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
      detail: { url, open: true },
      cancelable: true,
    }),
  );
  await waitForSolid(() => expect(badge()).toBe("Merged"));
  pending.resolve(open);
  await vi.advanceTimersByTimeAsync(0);
  expect(badge()).toBe("Merged");
  expect(anchor.getAttribute("aria-description")).toBe("Merged");
});

it.each([false, true])(
  "loads compact metrics without reverting fresh reader status (pending preview: %s)",
  async (pendingPreview) => {
    const pending = Promise.withResolvers<ControlUiLinkReaderDocument>();
    let previewReads = 0;
    const request = vi.fn((method: string) => {
      if (method === "github.detail") {
        return Promise.resolve(merged);
      }
      previewReads += 1;
      return pendingPreview && previewReads === 1 ? pending.promise : Promise.resolve(open);
    });
    const client = createTestGatewayClient(request);
    const { host, anchor } = makeProvider();
    host.client = client;
    if (pendingPreview) {
      await hover(anchor);
    }
    const panel = document.createElement("openclaw-link-reader-panel");
    panel.client = client;
    panel.available = true;
    panel.readers = [reader];
    mountSolid(() => panel);
    await panel.updateComplete;
    panel.handleToggleRequest(
      new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
        detail: { url, open: true },
        cancelable: true,
      }),
    );
    await waitForSolid(() =>
      expect(panel.querySelector(".lr-state")?.textContent).toContain("Merged"),
    );
    pending.resolve(open);
    anchor.dispatchEvent(
      new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
    );
    await vi.advanceTimersByTimeAsync(120);
    await hover(anchor);
    expect(badge()).toBe("Merged");
    expect(document.querySelector(".link-reader-hovercard__metadata")?.textContent).toBe("+42");
    expect(previewReads).toBe(pendingPreview ? 2 : 1);
  },
);

it("keeps reader facts visible when compact preview enrichment fails", async () => {
  const pending = Promise.withResolvers<ControlUiLinkReaderDocument>();
  let previewResponse = pending.promise;
  const request = vi.fn((method: string) =>
    method === "github.detail" ? Promise.resolve(merged) : previewResponse,
  );
  const client = createTestGatewayClient(request);
  const { host, anchor } = makeProvider();
  host.client = client;
  const panel = document.createElement("openclaw-link-reader-panel");
  panel.client = client;
  panel.available = true;
  panel.readers = [reader];
  mountSolid(() => panel);
  await panel.updateComplete;
  panel.handleToggleRequest(
    new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
      detail: { url, open: true },
      cancelable: true,
    }),
  );
  await waitForSolid(() => expect(anchor.getAttribute("aria-description")).toBe("Merged"));
  await hover(anchor);
  expect(anchor.getAttribute("aria-description")).toBe("Merged");
  pending.reject(new Error("Preview rate limited"));
  await vi.advanceTimersByTimeAsync(0);
  expect(badge()).toBe("Merged");
  expect(document.querySelector<HTMLElement>(".link-reader-hovercard")?.dataset.cached).toBe(
    "true",
  );
  anchor.dispatchEvent(
    new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
  );
  await vi.advanceTimersByTimeAsync(120);
  await hover(anchor);
  expect(badge()).toBe("Merged");
  expect(request.mock.calls.filter(([method]) => method === "github.preview")).toHaveLength(1);
  anchor.dispatchEvent(
    new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
  );
  await vi.advanceTimersByTimeAsync(30_000);
  await hover(anchor);
  expect(badge()).toBe("Merged");
  expect(anchor.getAttribute("aria-description")).toBe("Merged");
  expect(request.mock.calls.filter(([method]) => method === "github.preview")).toHaveLength(2);
  previewResponse = Promise.resolve(open);
  anchor.dispatchEvent(
    new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
  );
  await vi.advanceTimersByTimeAsync(30_000);
  await hover(anchor);
  expect(badge()).toBe("Merged");
  expect(document.querySelector(".link-reader-hovercard__metadata")?.textContent).toBe("+42");
  expect(request.mock.calls.filter(([method]) => method === "github.preview")).toHaveLength(3);
});
