/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import {
  createChatSessionSharingMobileAdapter,
  type ChatSessionSharingMobileAdapter,
} from "./chat-session-sharing-mobile-adapter.tsx";
import {
  ChatSessionAccessMobile,
  ChatSessionSharingMobile,
} from "./chat-session-sharing-mobile.tsx";
import type {
  PreparedChatSessionSharing,
  ChatSessionSharingOutcome,
} from "./chat-session-sharing-shared.tsx";

function prepared(overrides: Partial<PreparedChatSessionSharing> = {}): PreparedChatSessionSharing {
  return {
    session: {
      key: "agent:main:sharing",
      sessionId: "original",
      kind: "direct",
      visibility: "shared",
      sharingRole: "owner",
    },
    state: {
      loading: false,
      result: {
        sessionKey: "agent:main:sharing",
        role: "owner",
        allowedVisibilities: ["shared", "read-only", "suggest", "draft"],
        owner: { type: "human", id: "owner", label: "Owner" },
        identities: [{ type: "human", id: "member", label: "Pat Member" }],
        members: [],
      },
    },
    onOpen: vi.fn(),
    onVisibilityChange: vi.fn(async () => ({ status: "success" as const })),
    onMemberChange: vi.fn(async () => ({ status: "success" as const })),
    onPublicShareChange: vi.fn(async () => ({ status: "cancelled" as const })),
    onCopyPublicLink: vi.fn(async () => ({ status: "success" as const })),
    ...overrides,
  };
}

function accessFixture(initial: PreparedChatSessionSharing) {
  const [source, setSource] = createSignal(initial);
  let target: object | undefined = {};
  const applied = vi.fn();
  const view = mountSolid(() => {
    const adapter = createChatSessionSharingMobileAdapter(source, {
      onOpenSharing: vi.fn(),
      onOpenAccess: vi.fn(),
      onApplied: applied,
      accessTarget: () => target,
    });
    return <ChatSessionAccessMobile {...adapter.access} />;
  });
  return {
    ...view,
    applied,
    source,
    setSource,
    replaceTarget: () => {
      target = {};
    },
  };
}

it("returns from Session access only after a confirmed native success", async () => {
  const change = vi.fn<PreparedChatSessionSharing["onVisibilityChange"]>();
  const view = accessFixture(prepared({ onVisibilityChange: change }));
  for (const outcome of [
    { status: "cancelled" },
    { status: "failed", error: "Rejected" },
    { status: "success" },
  ] satisfies ChatSessionSharingOutcome[]) {
    const pending = createDeferred<ChatSessionSharingOutcome>();
    change.mockReturnValueOnce(pending.promise);
    view.getByRole("button", { name: /Draft/ }).click();
    expect(change).toHaveBeenLastCalledWith("draft");
    expect(view.applied).not.toHaveBeenCalled();
    pending.resolve(outcome);
    await pending.promise;
    await Promise.resolve();
    flush();
    if (outcome.status === "success") {
      expect(view.applied).toHaveBeenCalledOnce();
    } else {
      expect(view.applied).not.toHaveBeenCalled();
    }
  }
});

it.each(["destination", "session"] as const)(
  "does not navigate a replacement %s when an older update succeeds",
  async (replacement) => {
    const pending = createDeferred<ChatSessionSharingOutcome>();
    const change = vi
      .fn<PreparedChatSessionSharing["onVisibilityChange"]>()
      .mockReturnValue(pending.promise);
    const view = accessFixture(prepared({ onVisibilityChange: change }));
    view.getByRole("button", { name: /Draft/ }).click();
    if (replacement === "destination") {
      view.replaceTarget();
    } else {
      view.setSource({
        ...view.source(),
        session: { ...view.source().session, sessionId: "replacement" },
      });
    }
    flush();
    pending.resolve({ status: "success" });
    await pending.promise;
    await Promise.resolve();
    flush();
    expect(change).toHaveBeenCalledOnce();
    expect(view.applied).not.toHaveBeenCalled();
  },
);

it("keeps Public confirmed until its owner publishes and preserves membership focus while pending", async () => {
  const confirmation = createDeferred<ChatSessionSharingOutcome>();
  const publish = vi
    .fn<PreparedChatSessionSharing["onPublicShareChange"]>()
    .mockReturnValue(confirmation.promise);
  const member = vi
    .fn<PreparedChatSessionSharing["onMemberChange"]>()
    .mockResolvedValue({ status: "success" });
  const copy = vi
    .fn<PreparedChatSessionSharing["onCopyPublicLink"]>()
    .mockResolvedValue({ status: "success" });
  const initial = prepared({
    onPublicShareChange: publish,
    onMemberChange: member,
    onCopyPublicLink: copy,
  });
  const [source, setSource] = createSignal(initial);
  let adapter!: ChatSessionSharingMobileAdapter;
  const view = mountSolid(() => {
    adapter = createChatSessionSharingMobileAdapter(source, {
      onOpenSharing: vi.fn(),
      onOpenAccess: vi.fn(),
      onApplied: vi.fn(),
      accessTarget: () => undefined,
    });
    return <ChatSessionSharingMobile {...adapter.sharing} />;
  });
  const toggle = view.getByRole("switch") as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  toggle.click();
  expect(publish).toHaveBeenCalledExactlyOnceWith(true);
  expect(toggle.checked).toBe(false);
  confirmation.resolve({ status: "cancelled" });
  await confirmation.promise;
  await Promise.resolve();
  expect(toggle.checked).toBe(false);
  const permission = view.getByRole("checkbox", { name: /^Pat Member,/ });
  permission.focus();
  setSource({ ...initial, state: { ...initial.state!, loading: true } });
  flush();
  expect(document.activeElement).toBe(permission);
  expect(permission.getAttribute("aria-disabled")).toBe("true");
  permission.click();
  expect(member).not.toHaveBeenCalled();
  const url = "https://example.test/public/complete-session-link";
  setSource({
    ...initial,
    state: {
      loading: false,
      publicUrl: url,
      result: {
        ...initial.state!.result!,
        publicShare: { token: "synthetic-public-token", createdAt: 1 },
      },
    },
  });
  flush();
  expect(toggle.checked).toBe(true);
  permission.click();
  expect(member).toHaveBeenCalledExactlyOnceWith("member", true);
  expect(view.getByRole("checkbox", { name: /^Owner,/ }).hasAttribute("disabled")).toBe(true);
  const copyButton = view.getByRole("button", { name: "Copy public link" });
  expect(copyButton.textContent).toContain(url);
  copyButton.click();
  expect(copy).toHaveBeenCalledOnce();
  setSource((current) => ({ ...current, session: { ...current.session, sharingRole: "member" } }));
  flush();
  expect(adapter.available).toBe(false);
  expect(toggle.disabled).toBe(true);
  permission.click();
  expect(member).toHaveBeenCalledTimes(1);
});
