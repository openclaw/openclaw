/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionMembersListEvidenceResult } from "../../../api/types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createMountedPanes, refreshPane } from "../chat-pane-mounted.test-support.ts";
import { createChatSessionSharingMobileAdapter } from "./chat-session-sharing-mobile-adapter.tsx";
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
        permissions: [{ identityId: "member", level: "read", options: ["read", "send"] }],
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

function sharingFixture(initial: PreparedChatSessionSharing, access = false) {
  const [source, setSource] = createSignal(initial);
  let target: object | undefined = access ? {} : undefined;
  const applied = vi.fn();
  let adapter!: ReturnType<typeof createChatSessionSharingMobileAdapter>;
  const view = mountSolid(() => {
    adapter = createChatSessionSharingMobileAdapter(source, {
      onOpenSharing: vi.fn(),
      onOpenAccess: vi.fn(),
      onApplied: applied,
      accessTarget: () => target,
    });
    return access ? (
      <ChatSessionAccessMobile {...adapter.access} />
    ) : (
      <ChatSessionSharingMobile {...adapter.sharing} />
    );
  });
  const setState = (state: Partial<NonNullable<PreparedChatSessionSharing["state"]>>) => {
    setSource((current) => ({ ...current, state: { ...current.state!, ...state } }));
    flush();
  };
  return {
    ...view,
    applied,
    source,
    setSource,
    setState,
    person: (level = "read") => view.getByRole("button", { name: `Pat Member, Can ${level}` }),
    get adapter() {
      return adapter;
    },
    button: (name: RegExp) => view.getByRole("button", { name }),
    expectDisabled: (name: RegExp, disabled: boolean) =>
      waitForSolid(() =>
        expect(view.getByRole("button", { name }).hasAttribute("disabled")).toBe(disabled),
      ),
    replaceTarget: () => {
      target = {};
    },
  };
}
const accessFixture = (initial: PreparedChatSessionSharing) => sharingFixture(initial, true);

it("keeps sharing busy through refresh and retires it for a same-key successor", async () => {
  const initial = prepared();
  const previous = { ...initial.session, agentId: "main", visibility: "draft" as const };
  const replacement = {
    ...previous,
    sessionId: "successor",
    visibility: "read-only" as const,
    updatedAt: 2,
  };
  const rows: GatewaySessionRow[] = [previous];
  const fixture = createMountedPanes(rows);
  const pane = fixture.mount(previous.key) as ReturnType<typeof fixture.mount> & {
    prepareSessionSharing: (row: GatewaySessionRow) => PreparedChatSessionSharing;
    syncSelectedSessionSharing: (row: GatewaySessionRow) => void;
  };
  const response = createDeferred<unknown>();
  const refresh = createDeferred<SessionMembersListEvidenceResult>();
  const refreshStarted = createDeferred();
  let holdRefresh = false;
  const originalRequest = pane.state.client!.request.bind(pane.state.client!);
  vi.spyOn(pane.state.client!, "request").mockImplementation((method, params, options) => {
    if (method === "session.visibility.set") {
      return response.promise;
    }
    if (method === "session.members.listEvidence") {
      if (holdRefresh) {
        refreshStarted.resolve();
        return refresh.promise;
      }
      return Promise.resolve(initial.state!.result);
    }
    return originalRequest(method, params, options);
  });
  const snapshot = pane.context.gateway.snapshot;
  snapshot.phase = "connected";
  snapshot.hello = {
    ...snapshot.hello,
    auth: { role: "operator", scopes: ["operator.admin"] },
    features: {
      ...snapshot.hello?.features,
      methods: [
        "session.visibility.set",
        "session.members.listEvidence",
        "session.members.add",
        "session.members.remove",
        "session.publicShare.set",
      ],
    },
  } as typeof snapshot.hello;
  await refreshPane(pane);
  pane.syncSelectedSessionSharing(previous);
  await waitForSolid(() =>
    expect(pane.prepareSessionSharing(previous)?.state?.loading).toBe(false),
  );
  const source = pane.prepareSessionSharing(previous);
  const operation = vi.spyOn(source, "onVisibilityChange");
  const view = accessFixture(source);
  view.button(/Shared/).click();
  await view.expectDisabled(/Shared/, true);
  // A delayed header render may check hydration while the write is pending.
  pane.syncSelectedSessionSharing(previous);
  // Hold every post-write read, including any competing header hydration.
  holdRefresh = true;
  response.resolve({});
  await refreshStarted.promise;
  flush();
  expect(view.button(/Shared/).hasAttribute("disabled")).toBe(true);
  expect(view.applied).not.toHaveBeenCalled();
  holdRefresh = false;
  rows[0] = replacement;
  fixture.emitGatewayEvent("sessions.changed", {
    sessionKey: previous.key,
    agentId: "main",
    sessionId: replacement.sessionId,
    reason: "update",
    session: replacement,
  });
  await waitForSolid(() => expect(source.operationSignal?.aborted).toBe(true));
  pane.syncSelectedSessionSharing(replacement);
  await waitForSolid(() =>
    expect(pane.prepareSessionSharing(replacement)?.state?.loading).toBe(false),
  );
  view.setSource(pane.prepareSessionSharing(replacement));
  await waitForSolid(() =>
    expect(view.button(/Read-only/).getAttribute("aria-pressed")).toBe("true"),
  );
  expect(view.button(/Shared/).hasAttribute("disabled")).toBe(false);
  refresh.resolve(initial.state!.result!);
  await operation.mock.results[0]!.value;
  flush();
  expect(view.applied).not.toHaveBeenCalled();
});

it("retains access controls across rejection and retries, returning only on native success", async () => {
  const change = vi.fn<PreparedChatSessionSharing["onVisibilityChange"]>();
  const view = accessFixture(prepared({ onVisibilityChange: change }));
  const draft = view.button(/Draft/);
  for (const outcome of [
    new Error("Visibility command failed"),
    { status: "cancelled" },
    { status: "failed", error: "Rejected" },
    { status: "success" },
  ] satisfies Array<ChatSessionSharingOutcome | Error>) {
    const pending = createDeferred<ChatSessionSharingOutcome>();
    change.mockReturnValueOnce(pending.promise);
    draft.click();
    expect(change).toHaveBeenLastCalledWith("draft");
    expect(view.applied).not.toHaveBeenCalled();
    await view.expectDisabled(/Draft/, true);
    expect(view.queryByRole("alert")).toBeNull();
    if (outcome instanceof Error) {
      pending.reject(outcome);
      await waitForSolid(() =>
        expect(view.queryByRole("alert")?.textContent).toContain(outcome.message),
      );
    } else {
      pending.resolve(outcome);
      await pending.promise;
    }
    await view.expectDisabled(/Draft/, false);
    expect(view.button(/Draft/)).toBe(draft);
    if (!(outcome instanceof Error) && outcome.status === "success") {
      expect(view.applied).toHaveBeenCalledOnce();
    } else {
      expect(view.applied).not.toHaveBeenCalled();
    }
  }
});

it.each(["destination", "session"] as const)(
  "does not navigate or publish a retired error into a replacement %s",
  async (replacement) => {
    const pending = createDeferred<ChatSessionSharingOutcome>();
    const change = vi
      .fn<PreparedChatSessionSharing["onVisibilityChange"]>()
      .mockReturnValue(pending.promise);
    const lifetime = new AbortController();
    const view = accessFixture(
      prepared({ onVisibilityChange: change, operationSignal: lifetime.signal }),
    );
    view.button(/Draft/).click();
    await view.expectDisabled(/Draft/, true);
    if (replacement === "destination") {
      view.replaceTarget();
    } else {
      pending.reject(new Error("Retired update rejected"));
      lifetime.abort();
      view.setSource({
        ...view.source(),
        operationSignal: new AbortController().signal,
        session: { ...view.source().session, sessionId: "replacement", visibility: "read-only" },
      });
      await waitForSolid(() => {
        expect(view.button(/Read-only/).getAttribute("aria-pressed")).toBe("true");
        expect(view.button(/Draft/).hasAttribute("disabled")).toBe(false);
      });
    }
    flush();
    if (replacement === "destination") {
      pending.resolve({ status: "success" });
      await pending.promise;
    } else {
      await expect(pending.promise).rejects.toThrow("Retired update rejected");
    }
    await Promise.resolve();
    flush();
    expect(change).toHaveBeenCalledOnce();
    expect(view.applied).not.toHaveBeenCalled();
    expect(view.queryByRole("alert")).toBeNull();
  },
);

it("hides members in Shared and restores them when authoritative visibility changes", () => {
  const initial = prepared();
  const view = sharingFixture(initial);
  for (const visibility of [
    undefined,
    "read-only",
    "shared",
    "suggest",
    "draft",
    "shared",
  ] as const) {
    view.setSource({ ...initial, session: { ...initial.session, visibility } });
    flush();
    const visible = visibility === "read-only" || visibility === "suggest";
    expect(Boolean(view.queryByText("Permissions"))).toBe(visible);
    expect(Boolean(view.queryByRole("button", { name: "Pat Member, Can read" }))).toBe(visible);
    expect(Boolean(view.queryByRole("button", { name: "Search people…" }))).toBe(visible);
    expect(view.getByText("Session access")).toBeDefined();
    expect(view.getByText("Link sharing")).toBeDefined();
  }
  expect(initial.onMemberChange).not.toHaveBeenCalled();
  expect(initial.onVisibilityChange).not.toHaveBeenCalled();
  expect(initial.onPublicShareChange).not.toHaveBeenCalled();
});

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
  initial.session.visibility = "read-only";
  const view = sharingFixture(initial);
  const { setSource } = view;
  const setPermission = (level: "read" | "send") => {
    view.setState({
      result: {
        ...view.source().state!.result!,
        members: level === "send" ? [{ identityId: "member", addedBy: "owner", addedAt: 1 }] : [],
        permissions: [{ identityId: "member", level, options: ["read", "send"] }],
      },
    });
  };
  const toggle = view.getByRole("switch") as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  toggle.click();
  expect(publish).toHaveBeenCalledExactlyOnceWith(true);
  expect(toggle.checked).toBe(false);
  confirmation.resolve({ status: "cancelled" });
  await confirmation.promise;
  await Promise.resolve();
  expect(toggle.checked).toBe(false);
  expect(view.getByText("Permissions")).toBeDefined();
  const permission = view.person();
  expect(permission.textContent).toContain("Can read");
  expect(member).not.toHaveBeenCalled();
  permission.focus();
  view.setState({ loading: true });
  expect(document.activeElement).toBe(permission);
  expect(permission.getAttribute("aria-disabled")).toBe("true");
  expect(permission).toHaveProperty("disabled", false);
  permission.click();
  expect(member).not.toHaveBeenCalled();
  const url = "https://example.test/public/complete-session-link";
  view.setState({
    loading: false,
    publicUrl: url,
    result: {
      ...initial.state!.result!,
      publicShare: { token: "synthetic-public-token", createdAt: 1 },
    },
  });
  expect(toggle.checked).toBe(true);
  await waitForSolid(() => expect(permission.getAttribute("aria-disabled")).toBeNull());
  permission.click();
  await waitForSolid(() => expect(permission.getAttribute("aria-expanded")).toBe("true"));
  view.getByRole("menuitemradio", { name: "Can send" }).click();
  expect(member).toHaveBeenCalledExactlyOnceWith("member", true);
  await waitForSolid(() => expect(permission.getAttribute("aria-expanded")).toBe("false"));
  expect(view.queryByRole("button", { name: /^Owner,/ })).toBeNull();
  setPermission("send");
  expect(view.person("send")).toBe(permission);
  await waitForSolid(() => expect(permission.getAttribute("aria-disabled")).toBeNull());
  permission.click();
  await waitForSolid(() => expect(permission.getAttribute("aria-expanded")).toBe("true"));
  view.getByRole("menuitemradio", { name: "Can read" }).click();
  expect(member).toHaveBeenLastCalledWith("member", false);
  setPermission("read");
  expect(view.person()).toBe(permission);
  expect(permission.textContent).toContain("Can read");
  const copyButton = view.getByRole("button", { name: "Copy public link" });
  expect(copyButton.textContent).toContain(url);
  copyButton.click();
  expect(copy).toHaveBeenCalledOnce();
  setSource((current) => ({ ...current, session: { ...current.session, sharingRole: "member" } }));
  flush();
  expect(view.adapter.available).toBe(false);
  expect(toggle.hasAttribute("disabled")).toBe(true);
  permission.click();
  expect(member).toHaveBeenCalledTimes(2);
});

it("reads native permission readiness and retains people through refresh and failure", async () => {
  const initial = prepared();
  initial.session.visibility = "read-only";
  const read = createDeferred();
  const view = sharingFixture({
    ...initial,
    state: { loading: false, read: read.promise },
  });
  expect(view.getByRole("status", { name: "Loading…" }).getAttribute("aria-busy")).toBe("true");
  expect(view.queryByRole("button", { name: "Pat Member, Can read" })).toBeNull();
  view.setSource(initial);
  read.resolve();
  await waitForSolid(() => expect(view.person()).not.toBeNull());
  const person = view.person();
  expect(view.queryByRole("status", { name: "Loading…" })).toBeNull();
  const refresh = createDeferred();
  view.setState({ loading: true, read: refresh.promise });
  expect(view.person()).toBe(person);
  expect(person.getAttribute("aria-disabled")).toBe("true");
  expect(view.queryByRole("status", { name: "Loading…" })).toBeNull();
  view.setState({ loading: false, read: undefined, error: "Permission refresh failed" });
  refresh.resolve();
  await waitForSolid(() => expect(view.queryByRole("alert")).not.toBeNull());
  expect(view.getByRole("alert").textContent).toContain("Permission refresh failed");
  expect(view.person()).toBe(person);
});
