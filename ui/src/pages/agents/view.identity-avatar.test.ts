import { LitElement } from "lit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { setAvatarGatewayOrigin } from "../../lib/identity-avatar-context.ts";
import { IdentityAvatarController } from "../../lib/identity-avatar-loader.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { renderAgents } from "./view.ts";

const avatarPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDOsAAAAASUVORK5CYII=";
const identityWithAvatar = {
  beta: { agentId: "beta", name: "Fetched Beta", avatar: "/avatar/beta?v=1", emoji: "" },
};

class AgentAvatarView extends LitElement {
  private readonly avatarLoader = new IdentityAvatarController(this);
  props = createProps({
    agentsList: {
      defaultId: "beta",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "beta", name: "Beta" }],
    },
    agentIdentityById: identityWithAvatar,
    identityAvatarLoader: this.avatarLoader,
  });

  override createRenderRoot() {
    return this;
  }

  override render() {
    return this.avatarLoader.withActiveRoutes(() => renderAgents(this.props));
  }
}

customElements.define(`test-agent-avatar-view-${crypto.randomUUID()}`, AgentAvatarView);

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
    view.remove();
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

async function createView(overrides: Partial<ReturnType<typeof createProps>> = {}) {
  const view = new AgentAvatarView();
  view.props = { ...view.props, ...overrides };
  views.push(view);
  document.body.append(view);
  await view.updateComplete;
  return view;
}

function avatarImage(view: AgentAvatarView) {
  return view.querySelector<HTMLImageElement>(".agent-identity-editor__avatar img");
}

function avatarText(view: AgentAvatarView) {
  return view.querySelector(".agent-identity-editor__avatar-text")?.textContent;
}

async function changeAvatarRevision(view: AgentAvatarView, revision: number) {
  view.props.agentIdentityById = {
    beta: { ...identityWithAvatar.beta, avatar: `/avatar/beta?v=${revision}` },
  };
  view.requestUpdate();
  await view.updateComplete;
}

it("fetches a persisted settings avatar with the bearer credential", async () => {
  const response = createDeferred<Response>();
  fetchAvatar.mockReturnValue(response.promise);
  const view = await createView();

  try {
    expect(avatarImage(view)).toBeNull();
    expect(avatarText(view)).toBe("F");
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
    expect(fetchAvatar).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
  } finally {
    response.resolve(avatarResponse());
  }
});

it("renders the upload preview without fetching the persisted settings avatar", async () => {
  const preview = `data:image/png;base64,${avatarPng}`;
  const view = await createView({
    identityDraft: { name: null, emoji: null, avatar: preview },
  });

  expect(avatarImage(view)?.getAttribute("src")).toBe(preview);
  expect(fetchAvatar).not.toHaveBeenCalled();
});

it("keeps a missing settings avatar on its fallback and recovers on a new revision", async () => {
  fetchAvatar
    .mockResolvedValueOnce(avatarResponse())
    .mockResolvedValueOnce(new Response(null, { status: 404 }))
    .mockResolvedValueOnce(avatarResponse());
  const view = await createView();
  await waitForFast(() => {
    expect(avatarImage(view)?.getAttribute("src")).toBe("blob:settings-avatar-1");
  });

  await changeAvatarRevision(view, 2);
  await waitForFast(() => expect(fetchAvatar).toHaveBeenCalledTimes(2));
  view.props.identityDraft = { name: "Renamed Beta", emoji: null, avatar: null };
  view.requestUpdate();
  await view.updateComplete;
  expect(avatarImage(view)).toBeNull();
  expect(avatarText(view)).toBe("R");
  expect(fetchAvatar).toHaveBeenCalledTimes(2);

  await changeAvatarRevision(view, 3);
  await waitForFast(() => {
    expect(avatarImage(view)?.getAttribute("src")).toBe("blob:settings-avatar-2");
  });
  expect(fetchAvatar).toHaveBeenCalledTimes(3);
});

it("keeps a decode failure on its fallback across rerenders until the revision changes", async () => {
  fetchAvatar.mockImplementation(async () => avatarResponse());
  const view = await createView();
  const failedImage = await waitForFast(() => {
    const image = avatarImage(view);
    expect(image?.getAttribute("src")).toBe("blob:settings-avatar-1");
    return image;
  });
  failedImage?.dispatchEvent(new Event("error"));
  await view.updateComplete;
  expect(avatarImage(view)).toBeNull();
  expect(avatarText(view)).toBe("F");

  view.props.identityDraft = { name: "Renamed Beta", emoji: null, avatar: null };
  view.requestUpdate();
  await view.updateComplete;
  expect(avatarImage(view)).toBeNull();
  expect(avatarText(view)).toBe("R");
  expect(fetchAvatar).toHaveBeenCalledOnce();

  await changeAvatarRevision(view, 2);
  await waitForFast(() => {
    expect(avatarImage(view)?.getAttribute("src")).toBe("blob:settings-avatar-2");
  });
  failedImage?.dispatchEvent(new Event("error"));
  await view.updateComplete;
  expect(avatarImage(view)?.getAttribute("src")).toBe("blob:settings-avatar-2");
  expect(fetchAvatar).toHaveBeenCalledTimes(2);
});
