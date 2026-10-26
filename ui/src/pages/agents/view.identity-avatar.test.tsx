import { flush } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { cleanupSolid } from "../../test-helpers/solid-cleanup.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { Agents, type AgentsProps } from "./view.tsx";

const avatarPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDOsAAAAASUVORK5CYII=";
const pngBytes = Uint8Array.from(atob(avatarPng), (character) => character.charCodeAt(0));
const avatarResponse = () => new Response(pngBytes, { headers: { "content-type": "image/png" } });
const avatarUrl = (revision: number) => `${globalThis.location.origin}/avatar/beta?v=${revision}`;
const identity = (revision: number) => ({
  beta: { agentId: "beta", name: "Fetched Beta", avatar: `/avatar/beta?v=${revision}`, emoji: "" },
});
const fetchAvatar = vi.fn<typeof fetch>();
const createObjectURL = vi.fn<typeof URL.createObjectURL>();
const requestUrls = () =>
  fetchAvatar.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input)));

beforeEach(() => {
  const nativeFetch = globalThis.fetch;
  fetchAvatar.mockReset();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
      globalThis.location.href,
    );
    return url.origin === globalThis.location.origin && url.pathname === "/avatar/beta"
      ? fetchAvatar(input, init)
      : nativeFetch(input, init);
  });
  let sequence = 0;
  createObjectURL.mockReset().mockImplementation(() => `blob:settings-avatar-${++sequence}`);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = vi.fn<typeof URL.revokeObjectURL>();
    },
  );
  setAvatarGatewayOrigin(globalThis.location.origin, ["avatar-token"]);
});
afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createView(avatar: string | null = null) {
  const container = document.body.appendChild(document.createElement("div"));
  let props = createProps({
    agentIdentityById: identity(1),
    readData: () => ({
      ...createProps().readData(),
      identityDraft: { name: null, emoji: null, avatar },
    }),
  });
  const view = mountSolid(Agents, props, container);
  const query = (selector: string) => container.querySelector<HTMLElement>(selector);
  const image = () => query(".agent-identity-editor__avatar img");
  const classes = () => query(".agent-identity-editor__avatar .identity-avatar--agent")?.classList;
  const update = (next: Partial<AgentsProps>) => view.update((props = { ...props, ...next }));
  const loaded = (sequence: number) =>
    waitForFast(() => {
      expect(image()?.getAttribute("src")).toBe(`blob:settings-avatar-${sequence}`);
      return image();
    });
  const fallback = async () => {
    await waitForFast(() =>
      expect(query(".agent-identity-editor__avatar .identity-avatar__agent-face")).not.toBeNull(),
    );
    expect(classes()).toContain("is-fallback");
  };
  return {
    query,
    image,
    classes,
    loaded,
    fallback,
    revision: (revision: number) => update({ agentIdentityById: identity(revision) }),
    rename: () =>
      update({
        readData: () => ({
          ...createProps().readData(),
          identityDraft: { name: "Renamed Beta", emoji: null, avatar: null },
        }),
      }),
  };
}

it("shares one authenticated avatar between editor and picker", async () => {
  const response = createDeferred<Response>();
  fetchAvatar.mockReturnValue(response.promise);
  const view = createView();
  try {
    const classes = view.classes();
    expect(classes).toContain("is-pending");
    expect(classes).not.toContain("is-fallback");
    const chooser = view.query('button[aria-label="Edit avatar"]');
    chooser?.click();
    flush();
    view.query(".avatar-picker__tab:nth-child(2)")?.click();
    flush();
    const preview = view.query(".avatar-picker__preview .identity-avatar--agent");
    const image = preview?.querySelector("img");
    expect(preview?.classList).toContain("is-pending");
    expect(image?.getAttribute("src")).toBeNull();
    await waitForFast(() => expect(requestUrls()).toEqual([avatarUrl(1)]));
    response.resolve(avatarResponse());
    await view.loaded(1);
    await waitForFast(() => expect(image?.getAttribute("src")).toBe("blob:settings-avatar-1"));
    image?.dispatchEvent(new Event("load"));
    flush();
    expect(preview?.classList).not.toContain("is-pending");
    expect(classes).toContain("is-pending");
    view.image()?.dispatchEvent(new Event("load"));
    flush();
    expect(classes).not.toContain("is-pending");
    expect(requestUrls()).toEqual([avatarUrl(1)]);
  } finally {
    response.resolve(avatarResponse());
  }
});

it("renders the upload preview without fetching the persisted settings avatar", () => {
  const preview = `data:image/png;base64,${avatarPng}`;
  expect(createView(preview).image()?.getAttribute("src")).toBe(preview);
  expect(fetchAvatar).not.toHaveBeenCalled();
});

it.each(["missing", "decode"] as const)(
  "keeps a %s failure on fallback until a new revision",
  async (failure) => {
    fetchAvatar.mockImplementation(async () => avatarResponse());
    const view = createView();
    const failedImage = await view.loaded(1);
    const failedRevision = failure === "missing" ? 2 : 1;
    const expectedRequests = Array.from({ length: failedRevision }, (_, i) => avatarUrl(i + 1));
    if (failure === "missing") {
      fetchAvatar.mockResolvedValueOnce(new Response(null, { status: 404 }));
      view.revision(2);
      await waitForFast(() => expect(requestUrls()).toEqual(expectedRequests));
    } else {
      failedImage?.dispatchEvent(new Event("error"));
    }
    await waitForFast(() => expect(view.image()).toBeNull());
    await view.fallback();
    view.rename();
    expect(view.image()).toBeNull();
    await view.fallback();
    expect(requestUrls()).toEqual(expectedRequests);
    view.revision(failedRevision + 1);
    await view.loaded(2);
    expect(requestUrls()).toEqual([...expectedRequests, avatarUrl(failedRevision + 1)]);
    if (failure === "decode") {
      failedImage?.dispatchEvent(new Event("error"));
      await Promise.resolve();
      expect(view.image()?.getAttribute("src")).toBe("blob:settings-avatar-2");
      expect(fetchAvatar).toHaveBeenCalledTimes(2);
    }
  },
);

it("keeps a reopened picker preview pending until the authenticated avatar resolves", async () => {
  const response = createDeferred<Response>();
  fetchAvatar.mockReturnValue(response.promise);
  const view = createView();
  const chooser = view.query('button[aria-label="Edit avatar"]');
  expect(chooser).not.toBeNull();
  chooser?.click();
  flush();
  view.query(".avatar-picker__tab:nth-child(2)")?.click();
  flush();
  const preview = view.query(".avatar-picker__preview .identity-avatar--agent");
  const image = preview?.querySelector("img");
  await waitForFast(() => expect(fetchAvatar).toHaveBeenCalledOnce());
  expect(preview?.classList).toContain("is-pending");
  expect(image?.getAttribute("src")).toBeNull();
  response.resolve(avatarResponse());
  await waitForFast(() => expect(image?.getAttribute("src")).toBe("blob:settings-avatar-1"));
  image?.dispatchEvent(new Event("load"));
  flush();
  expect(preview?.classList).not.toContain("is-pending");
  expect(fetchAvatar).toHaveBeenCalledOnce();
});
