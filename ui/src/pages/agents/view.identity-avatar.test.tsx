import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { Agents, type AgentsProps } from "./view.tsx";

const avatarPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDOsAAAAASUVORK5CYII=";
const identityWithAvatar = {
  beta: { agentId: "beta", name: "Fetched Beta", avatar: "/avatar/beta?v=1", emoji: "" },
};

type AgentAvatarView = ReturnType<typeof mountSolid<AgentsProps>> & { props: AgentsProps };

const views: AgentAvatarView[] = [];
const fetchAvatar = vi.fn<typeof fetch>();
const createObjectURL = vi.fn<typeof URL.createObjectURL>();
const revokeObjectURL = vi.fn<typeof URL.revokeObjectURL>();

beforeEach(() => {
  const nativeFetch = globalThis.fetch;
  fetchAvatar.mockReset();
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith("data:") ? nativeFetch(input, init) : fetchAvatar(input, init);
  });
  let sequence = 0;
  createObjectURL.mockReset().mockImplementation(() => `blob:settings-avatar-${++sequence}`);
  revokeObjectURL.mockReset();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  setAvatarGatewayOrigin(globalThis.location.origin, ["avatar-token"]);
});

afterEach(() => {
  for (const view of views.splice(0)) {
    view.dispose();
    view.container.remove();
  }
  setAvatarGatewayOrigin(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function avatarResponse() {
  return new Response(
    Uint8Array.from(atob(avatarPng), (character) => character.charCodeAt(0)),
    {
      headers: { "content-type": "image/png" },
    },
  );
}

function createView(overrides: Partial<ReturnType<typeof createProps>> = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const props = createProps({
    agentsList: {
      defaultId: "beta",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "beta", name: "Beta" }],
    },
    agentIdentityById: identityWithAvatar,
    ...overrides,
  });
  const view = { ...mountSolid(Agents, props, container), props };
  views.push(view);
  return view;
}

function avatarImage(view: AgentAvatarView) {
  return view.container.querySelector<HTMLImageElement>(".agent-identity-editor__avatar img");
}

async function expectAvatarFallback(view: AgentAvatarView) {
  await waitForFast(() => {
    expect(
      view.container.querySelector(".agent-identity-editor__avatar .identity-avatar__agent-face"),
    ).not.toBeNull();
  });
  expect(
    view.container.querySelector(".agent-identity-editor__avatar .identity-avatar--agent")
      ?.classList,
  ).toContain("is-fallback");
}

function updateView(view: AgentAvatarView, next: Partial<AgentsProps>) {
  view.props = { ...view.props, ...next };
  view.update(view.props);
}

function changeAvatarRevision(view: AgentAvatarView, revision: number) {
  updateView(view, {
    agentIdentityById: {
      beta: { ...identityWithAvatar.beta, avatar: `/avatar/beta?v=${revision}` },
    },
  });
}

it("fetches a persisted settings avatar with the bearer credential", async () => {
  const response = createDeferred<Response>();
  fetchAvatar.mockReturnValue(response.promise);
  const view = createView();

  try {
    const avatar = view.container.querySelector(
      ".agent-identity-editor__avatar .identity-avatar--agent",
    );
    expect(avatar?.classList).toContain("is-pending");
    expect(avatar?.classList).not.toContain("is-fallback");
    expect(fetchAvatar).toHaveBeenCalledWith(
      `${globalThis.location.origin}/avatar/beta?v=1`,
      expect.objectContaining({
        credentials: "include",
        headers: { Authorization: "Bearer avatar-token" },
        signal: expect.any(AbortSignal),
      }),
    );

    response.resolve(avatarResponse());
    await waitForFast(() => {
      expect(avatarImage(view)?.getAttribute("src")).toBe("blob:settings-avatar-1");
    });
    expect(avatar?.classList).toContain("is-pending");
    avatarImage(view)?.dispatchEvent(new Event("load"));
    expect(avatar?.classList).not.toContain("is-pending");
    expect(fetchAvatar).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
  } finally {
    response.resolve(avatarResponse());
  }
});

it("renders the upload preview without fetching the persisted settings avatar", () => {
  const preview = `data:image/png;base64,${avatarPng}`;
  const view = createView({
    overview: {
      ...createProps().overview,
      identityDraft: { name: null, emoji: null, avatar: preview },
    },
  });

  expect(avatarImage(view)?.getAttribute("src")).toBe(preview);
  expect(fetchAvatar).not.toHaveBeenCalled();
});

it("keeps a missing settings avatar on its fallback and recovers on a new revision", async () => {
  fetchAvatar
    .mockResolvedValueOnce(avatarResponse())
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(avatarResponse());
  const view = createView();
  await waitForFast(() => {
    expect(avatarImage(view)?.getAttribute("src")).toBe("blob:settings-avatar-1");
  });

  changeAvatarRevision(view, 2);
  await waitForFast(() => expect(fetchAvatar).toHaveBeenCalledTimes(2));
  await waitForFast(() => expect(avatarImage(view)).toBeNull());
  updateView(view, {
    overview: {
      ...view.props.overview,
      identityDraft: { name: "Renamed Beta", emoji: null, avatar: null },
    },
  });
  expect(avatarImage(view)).toBeNull();
  await expectAvatarFallback(view);
  expect(fetchAvatar).toHaveBeenCalledTimes(2);

  changeAvatarRevision(view, 3);
  await waitForFast(() => {
    expect(avatarImage(view)?.getAttribute("src")).toBe("blob:settings-avatar-2");
  });
  expect(fetchAvatar).toHaveBeenCalledTimes(3);
});

it("keeps a decode failure on its fallback across rerenders until the revision changes", async () => {
  fetchAvatar.mockImplementation(async () => avatarResponse());
  const view = createView();
  const failedImage = await waitForFast(() => {
    const image = avatarImage(view);
    expect(image?.getAttribute("src")).toBe("blob:settings-avatar-1");
    return image;
  });
  failedImage?.dispatchEvent(new Event("error"));
  await waitForFast(() => expect(avatarImage(view)).toBeNull());
  await expectAvatarFallback(view);

  updateView(view, {
    overview: {
      ...view.props.overview,
      identityDraft: { name: "Renamed Beta", emoji: null, avatar: null },
    },
  });
  expect(avatarImage(view)).toBeNull();
  await expectAvatarFallback(view);
  expect(fetchAvatar).toHaveBeenCalledOnce();

  changeAvatarRevision(view, 2);
  await waitForFast(() => {
    expect(avatarImage(view)?.getAttribute("src")).toBe("blob:settings-avatar-2");
  });
  failedImage?.dispatchEvent(new Event("error"));
  await Promise.resolve();
  expect(avatarImage(view)?.getAttribute("src")).toBe("blob:settings-avatar-2");
  expect(fetchAvatar).toHaveBeenCalledTimes(2);
});
