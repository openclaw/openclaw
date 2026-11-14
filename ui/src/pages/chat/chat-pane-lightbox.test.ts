/* @vitest-environment jsdom */
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ImageLightboxItem } from "../../components/image-lightbox.types.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import * as toast from "../../lib/toast.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { createTestChatPane } from "./chat-pane.test-support.ts";

let originalStyle: string | null;
beforeEach(() => {
  originalStyle = document.documentElement.getAttribute("style");
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalStyle === null) {
    document.documentElement.removeAttribute("style");
  } else {
    document.documentElement.setAttribute("style", originalStyle);
  }
});

it.each(["session", "selection", "connection", "access", "participation", "uploads"] as const)(
  "does not stage an original after its %s is retired",
  async (retired) => {
    const { pane, state } = createTestChatPane({
      client: createGatewayBrowserClientFixture({
        request: (method) => (method === "sessions.list" ? { sessions: [] } : {}),
      }),
    });
    pane.active = true;
    pane.presented = true;
    state.chatMessage = "Keep the unsent draft.";
    state.handleOpenImage({ src: "data:image/png;base64,cG5n", title: "reference.png" });
    const original = createDeferred<Blob>();
    const item: ImageLightboxItem = {
      src: "data:image/png;base64,cG5n",
      title: "reference.png",
      readOriginalBlob: vi.fn(() => original.promise),
    };
    const use = pane.render().layout!.overlays.onUseImage!;
    expect(use).toBeTypeOf("function");
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
    const pending = use(item, () => true);
    await vi.waitFor(() => expect(item.readOriginalBlob).toHaveBeenCalledOnce());
    if (retired === "session") {
      state.sessionKey = "agent:main:another";
    }
    if (retired === "selection") {
      state.beginImageOpen();
    }
    if (retired === "connection") {
      pane.connectionGeneration += 1;
    }
    if (retired === "access") {
      const snapshot = pane.context.gateway.snapshot;
      pane.applyGatewaySnapshot({
        ...snapshot,
        hello: snapshot.hello
          ? { ...snapshot.hello, auth: { ...snapshot.hello.auth, scopes: ["operator.read"] } }
          : null,
      });
    }
    if (retired === "participation") {
      state.sessionsResult = sessionsResult([
        { key: state.sessionKey, kind: "direct", visibility: "read-only", sharingRole: "viewer" },
      ]);
    }
    if (retired === "uploads") {
      state.uploadConfig!.current.uploadsEnabled = false;
    }
    original.resolve(new Blob(["original"], { type: "image/png" }));
    await pending;
    expect(state.chatAttachments).toHaveLength(0);
    expect(read).not.toHaveBeenCalled();
    expect(state.chatMessage).toBe("Keep the unsent draft.");
    read.mockRestore();
  },
);

it("retains the draft and selected image when the original read fails or exceeds admission", async () => {
  const { pane, state } = createTestChatPane();
  pane.active = true;
  pane.presented = true;
  state.chatMessage = "Keep the composition.";
  state.handleOpenImage({ src: "data:image/png;base64,cG5n", title: "reference.png" });
  const selected = state.imageLightbox;
  const use = pane.render().layout!.overlays.onUseImage!;
  await expect(
    use(
      {
        src: "preview.png",
        title: "reference.png",
        readOriginalBlob: async () => {
          throw new Error("No longer readable");
        },
      },
      () => true,
    ),
  ).rejects.toThrow("No longer readable");
  const notice = vi.spyOn(toast, "showToast").mockReturnValue(true);
  state.hello = {
    ...state.hello!,
    policy: {
      ...state.hello!.policy,
      maxPayload: 1024 * 1024,
      attachments: { maxBytes: 1, maxImageBytes: 1 },
    },
  };
  await use(
    {
      src: "preview.png",
      title: "reference.svg",
      readOriginalBlob: async () => new Blob(["<svg></svg>"], { type: "image/svg+xml" }),
    },
    () => true,
  );
  expect(state.chatAttachments).toHaveLength(0);
  expect(state.imageLightbox).toBe(selected);
  expect(state.chatMessage).toBe("Keep the composition.");
  expect(notice).toHaveBeenCalledWith(expect.objectContaining({ severity: "error" }));
  notice.mockRestore();
});

it("does not offer image attachments in the editable text-only suggestion composer", () => {
  const { pane, state } = createTestChatPane();
  pane.active = true;
  pane.presence.update({
    presence: [
      { user: { id: "owner" }, ts: 1 },
      { user: { id: "viewer" }, ts: 1 },
    ],
  });
  const hello = pane.context.gateway.snapshot.hello!;
  hello.features = {
    ...hello.features,
    methods: [
      ...(hello.features?.methods ?? []),
      "session.suggestions.add",
      "session.suggestions.list",
    ],
  };
  state.sessionsResult = sessionsResult([
    { key: state.sessionKey, kind: "direct", visibility: "suggest", sharingRole: "viewer" },
  ]);
  const layout = pane.render().layout!;
  expect(layout.primary.chat.suggestionComposer).toBe(true);
  expect(layout.primary.chat.canCompose).toBe(true);
  expect(layout.overlays.onUseImage).toBeUndefined();
});
