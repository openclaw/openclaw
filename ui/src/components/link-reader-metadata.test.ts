/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { GatewayBrowserClient } from "../api/gateway.ts";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { LinkReaderHovercardProvider } from "./link-reader-hovercard.ts";
import { subscribeLinkReaderMetadata } from "./link-reader-metadata.ts";
import {
  LINK_READER_METADATA_REQUEST_EVENT,
  LINK_READER_METADATA_UPDATED_EVENT,
} from "./link-reader-response.ts";
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
};
const merged: ControlUiLinkReaderDocument = {
  ...open,
  badge: { label: "Merged", tone: "accent" },
  metadata: [{ label: "Additions", value: "42" }],
};
function makeProvider(client: GatewayBrowserClient) {
  const host = document.createElement(tag);
  if (!(host instanceof LinkReaderHovercardProvider)) {
    throw new Error("Missing reader bridge");
  }
  host.readers = [reader];
  host.client = client;
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.className = "markdown-github-item";
  anchor.textContent = "PR #99816";
  host.append(anchor);
  document.body.append(host);
  return { host, anchor, client };
}
async function hover(anchor: HTMLAnchorElement) {
  await Promise.resolve();
  anchor.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  await vi.advanceTimersByTimeAsync(250);
}
const detailRequest = (preview: () => Promise<ControlUiLinkReaderDocument>) =>
  vi.fn((method: string) => (method === "github.detail" ? Promise.resolve(merged) : preview()));
async function rehover(anchor: HTMLAnchorElement, delay = 120) {
  anchor.dispatchEvent(
    new MouseEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
  );
  await vi.advanceTimersByTimeAsync(delay);
  await hover(anchor);
}
async function openPanel(props: Partial<HTMLElementTagNameMap["openclaw-link-reader-panel"]>) {
  const panel = Object.assign(document.createElement("openclaw-link-reader-panel"), {
    available: true,
    readers: [reader],
    ...props,
  });
  mountSolid(() => panel);
  await panel.updateComplete;
  panel.handleToggleRequest(
    new CustomEvent(LINK_READER_PANEL_TOGGLE_EVENT, {
      detail: { url, open: true },
      cancelable: true,
    }),
  );
  return panel;
}
const badge = () => document.querySelector(".link-reader-hovercard__state")?.textContent?.trim();
const metadata = () => document.querySelector(".link-reader-hovercard__metadata")?.textContent;
const cached = () => document.querySelector<HTMLElement>(".link-reader-hovercard")?.dataset.cached;
const previews = (request: ReturnType<typeof vi.fn>) =>
  request.mock.calls.filter(([method]) => method === "github.preview");
const panelMerged = (panel: HTMLElement) =>
  waitForSolid(() => expect(panel.querySelector(".lr-state")?.textContent).toContain("Merged"));
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

it("shares metadata delivery and panel replay across a mounting batch of providers", async () => {
  const client = createTestGatewayClient(() => Promise.resolve(merged));
  const panel = await openPanel({ client });
  await waitForSolid(() =>
    expect(panel.querySelector(".lr-state")?.textContent).toContain("Merged"),
  );
  const requestMetadata = vi.fn();
  window.addEventListener(LINK_READER_METADATA_REQUEST_EVENT, requestMetadata);
  onTestFinished(() =>
    window.removeEventListener(LINK_READER_METADATA_REQUEST_EVENT, requestMetadata),
  );
  const listen = vi.spyOn(window, "addEventListener");
  const unlisten = vi.spyOn(window, "removeEventListener");
  const rows = Array.from({ length: 100 }, () => makeProvider(client));
  expect(
    listen.mock.calls.filter(([type]) => type === LINK_READER_METADATA_UPDATED_EVENT),
  ).toHaveLength(1);
  await waitForSolid(() =>
    expect(rows.every(({ anchor }) => anchor.getAttribute("aria-description") === "Merged")).toBe(
      true,
    ),
  );
  expect(requestMetadata).toHaveBeenCalledOnce();

  rows[0]!.host.agentId = "another-agent";
  await Promise.resolve();
  expect(rows[0]!.anchor.hasAttribute("aria-description")).toBe(false);
  expect(rows[1]!.anchor.getAttribute("aria-description")).toBe("Merged");
  rows.slice(0, 99).forEach(({ host }) => host.remove());
  expect(
    unlisten.mock.calls.filter(([type]) => type === LINK_READER_METADATA_UPDATED_EVENT),
  ).toHaveLength(0);
  rows[99]!.host.remove();
  expect(
    unlisten.mock.calls.filter(([type]) => type === LINK_READER_METADATA_UPDATED_EVENT),
  ).toHaveLength(1);

  requestMetadata.mockClear();
  const retired = makeProvider(client);
  retired.host.remove();
  await Promise.resolve();
  expect(requestMetadata).not.toHaveBeenCalled();
});

it("writes inline badge attributes only when metadata changes", async () => {
  const client = createTestGatewayClient(() => Promise.resolve(open));
  const { anchor } = makeProvider(client);
  await Promise.resolve();
  const observer = new MutationObserver(() => {});
  observer.observe(anchor, {
    attributes: true,
    attributeFilter: ["aria-description", "data-link-reader-tone"],
  });
  onTestFinished(() => observer.disconnect());
  const mutations = () =>
    observer
      .takeRecords()
      .map((record) => record.attributeName)
      .toSorted((left, right) => String(left).localeCompare(String(right)));
  const publish = (preview: ControlUiLinkReaderDocument) =>
    window.dispatchEvent(
      new CustomEvent(LINK_READER_METADATA_UPDATED_EVENT, {
        detail: {
          client,
          agentId: undefined,
          sessionKey: undefined,
          target: { href: url, reader },
          preview,
        },
      }),
    );

  publish(open);
  expect(mutations()).toEqual(["aria-description", "data-link-reader-tone"]);
  for (let index = 0; index < 20; index += 1) {
    publish(open);
  }
  expect(mutations()).toEqual([]);
  expect(anchor.getAttribute("aria-description")).toBe("Open");
  expect(anchor.dataset.linkReaderTone).toBe("positive");

  publish(merged);
  expect(mutations()).toEqual(["aria-description", "data-link-reader-tone"]);
  expect(anchor.getAttribute("aria-description")).toBe("Merged");
  expect(anchor.dataset.linkReaderTone).toBe("accent");

  const cleared = { ...merged, badge: undefined };
  publish(cleared);
  expect(mutations()).toEqual(["aria-description", "data-link-reader-tone"]);
  expect(anchor.hasAttribute("aria-description")).toBe(false);
  expect(anchor.hasAttribute("data-link-reader-tone")).toBe(false);
  publish(cleared);
  expect(mutations()).toEqual([]);
});

it("isolates metadata callbacks and retires duplicate registrations independently", () => {
  const client = createTestGatewayClient(() => Promise.resolve(merged));
  const scope = { client, agentId: undefined, sessionKey: undefined };
  const report = vi.fn();
  vi.stubGlobal("reportError", report);
  const notify = vi.fn();
  const failure = new Error("Metadata presentation failed");
  let stopRetired = () => {};
  const stopFirst = subscribeLinkReaderMetadata(window, scope, () => {
    stopRetired();
    throw failure;
  });
  stopRetired = subscribeLinkReaderMetadata(window, scope, notify);
  const stopLast = subscribeLinkReaderMetadata(window, scope, notify);
  onTestFinished(() => {
    stopFirst();
    stopRetired();
    stopLast();
  });
  window.dispatchEvent(
    new CustomEvent(LINK_READER_METADATA_UPDATED_EVENT, {
      detail: {
        ...scope,
        target: { href: url, reader },
        preview: merged,
      },
    }),
  );
  expect(notify).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledExactlyOnceWith(failure);
});

it.each([
  ...["same", "other-client", "other-agent", "other-session"].flatMap((scope) =>
    [false, true].map((late) => ({ scope, late })),
  ),
  { scope: "replaced-client", late: true },
])(
  "reconciles detail metadata only in the matching $scope scope (late provider: $late)",
  async ({ scope, late }) => {
    const request = detailRequest(() => Promise.resolve(open));
    const { host, anchor, client } = makeProvider(createTestGatewayClient(request));
    host.agentId = "main";
    host.sessionKey = "agent:main:pane-one";
    if (late) {
      host.remove();
    } else {
      await hover(anchor);
      expect(badge()).toBe("Open");
    }
    const panel = await openPanel({
      client: scope === "other-client" ? createTestGatewayClient(request) : client,
      agentId: scope === "other-agent" ? "other" : "main",
      sessionKey: scope === "other-session" ? "agent:main:pane-two" : "agent:main:pane-one",
    });
    await panelMerged(panel);
    if (late) {
      if (scope === "replaced-client") {
        const replacement = createTestGatewayClient((method) =>
          method === "github.detail" ? new Promise(() => {}) : Promise.resolve(open),
        );
        panel.client = replacement;
        host.client = replacement;
      }
      document.body.append(host);
    } else {
      expect(badge()).toBe(scope === "same" ? "Merged" : "Open");
    }
    await rehover(anchor);
    expect(badge()).toBe(scope === "same" ? "Merged" : "Open");
    expect(metadata()).toBe("+42");
    expect(previews(request)).toHaveLength(scope === "replaced-client" ? 0 : 1);
  },
);

it.each([false, true])(
  "shows stale metadata immediately and reads fresh facts after backoff (session scoped: %s)",
  async (sessionScoped) => {
    const stale = { ...open, stale: true };
    const request = vi
      .fn()
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(stale)
      .mockResolvedValue(merged);
    const { host, anchor } = makeProvider(createTestGatewayClient(request));
    host.sessionKey = "agent:main:pane-one";
    host.readers = [{ ...reader, linkReader: { ...reader.linkReader, sessionScoped } }];
    await hover(anchor);
    expect(badge()).toBe("Open");
    expect(cached()).toBe("true");
    expect(request).toHaveBeenCalledTimes(1);
    await rehover(anchor);
    expect(request).toHaveBeenCalledTimes(1);
    await rehover(anchor, 30_000);
    expect(badge()).toBe("Open");
    expect(cached()).toBe("true");
    expect(request).toHaveBeenCalledTimes(2);
    await rehover(anchor);
    expect(request).toHaveBeenCalledTimes(2);
    await rehover(anchor, 30_000);
    expect(badge()).toBe("Merged");
    expect(cached()).toBe("false");
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).toEqual({
      url,
      ...(sessionScoped ? { sessionKey: "agent:main:pane-one" } : {}),
    });
  },
);

it.each([false, true])(
  "loads compact metrics without reverting fresh reader status (pending preview: %s)",
  async (pendingPreview) => {
    const pending = Promise.withResolvers<ControlUiLinkReaderDocument>();
    let previewReads = 0;
    const request = detailRequest(() => {
      previewReads += 1;
      return pendingPreview && previewReads === 1 ? pending.promise : Promise.resolve(open);
    });
    const { anchor, client } = makeProvider(createTestGatewayClient(request));
    if (pendingPreview) {
      await hover(anchor);
    }
    const panel = await openPanel({ client });
    await panelMerged(panel);
    if (pendingPreview) {
      expect(badge()).toBe("Merged");
    }
    pending.resolve(open);
    await vi.advanceTimersByTimeAsync(0);
    expect(anchor.getAttribute("aria-description")).toBe("Merged");
    if (pendingPreview) {
      expect(badge()).toBe("Merged");
    }
    await rehover(anchor);
    expect(badge()).toBe("Merged");
    expect(metadata()).toBe("+42");
    expect(previewReads).toBe(pendingPreview ? 2 : 1);
  },
);

it("keeps reader facts visible when compact preview enrichment fails", async () => {
  const pending = Promise.withResolvers<ControlUiLinkReaderDocument>();
  let previewResponse = pending.promise;
  const request = detailRequest(() => previewResponse);
  const { anchor, client } = makeProvider(createTestGatewayClient(request));
  await openPanel({ client });
  await waitForSolid(() => expect(anchor.getAttribute("aria-description")).toBe("Merged"));
  await hover(anchor);
  expect(anchor.getAttribute("aria-description")).toBe("Merged");
  pending.reject(new Error("Preview rate limited"));
  await vi.advanceTimersByTimeAsync(0);
  expect(badge()).toBe("Merged");
  expect(cached()).toBe("true");
  await rehover(anchor);
  expect(badge()).toBe("Merged");
  expect(previews(request)).toHaveLength(1);
  await rehover(anchor, 30_000);
  expect(badge()).toBe("Merged");
  expect(anchor.getAttribute("aria-description")).toBe("Merged");
  expect(previews(request)).toHaveLength(2);
  previewResponse = Promise.resolve(open);
  await rehover(anchor, 30_000);
  expect(badge()).toBe("Merged");
  expect(metadata()).toBe("+42");
  expect(previews(request)).toHaveLength(3);
});
