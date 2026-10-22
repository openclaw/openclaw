/* @vitest-environment jsdom */
import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { GatewaySessionRow, SessionMembersListEvidenceResult } from "../../../api/types.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { createMountedPanes, refreshPane } from "../chat-pane-mounted.test-support.ts";
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
  view.getByRole("button", { name: /Shared/ }).click();
  await waitForSolid(() =>
    expect(
      view.getByRole("button", { name: /Shared/ }).hasAttribute("disabled"),
      "sharing is busy after the visibility change starts",
    ).toBe(true),
  );
  // A delayed header render may check hydration while the write is pending.
  pane.syncSelectedSessionSharing(previous);
  // Hold every post-write read, including any competing header hydration.
  holdRefresh = true;
  response.resolve({});
  await refreshStarted.promise;
  flush();
  expect(
    view.getByRole("button", { name: /Shared/ }).hasAttribute("disabled"),
    "sharing stays busy while its refresh is pending",
  ).toBe(true);
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
  await waitForSolid(() =>
    expect(
      source.operationSignal?.aborted,
      "the successor retires the original sharing scope",
    ).toBe(true),
  );
  pane.syncSelectedSessionSharing(replacement);
  await waitForSolid(() =>
    expect(pane.prepareSessionSharing(replacement)?.state?.loading).toBe(false),
  );
  view.setSource(pane.prepareSessionSharing(replacement));
  await waitForSolid(() =>
    expect(view.getByRole("button", { name: /Read-only/ }).getAttribute("aria-pressed")).toBe(
      "true",
    ),
  );
  expect(view.getByRole("button", { name: /Shared/ }).hasAttribute("disabled")).toBe(false);
  refresh.resolve(initial.state!.result!);
  await operation.mock.results[0]!.value;
  flush();
  expect(view.applied).not.toHaveBeenCalled();
});

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
    await waitForSolid(() => {
      expect(view.getByRole("button", { name: /Draft/ }).hasAttribute("disabled")).toBe(true);
    });
    pending.resolve(outcome);
    await pending.promise;
    await waitForSolid(() => {
      expect(view.getByRole("button", { name: /Draft/ }).hasAttribute("disabled")).toBe(false);
    });
    if (outcome.status === "success") {
      expect(view.applied).toHaveBeenCalledOnce();
    } else {
      expect(view.applied).not.toHaveBeenCalled();
    }
  }
});

it("retains access controls through a rejected command and a held retry", async () => {
  const retry = createDeferred<ChatSessionSharingOutcome>();
  const change = vi
    .fn<PreparedChatSessionSharing["onVisibilityChange"]>()
    .mockRejectedValueOnce(new Error("Visibility command failed"))
    .mockReturnValueOnce(retry.promise);
  const view = accessFixture(prepared({ onVisibilityChange: change }));
  const draft = view.getByRole("button", { name: /Draft/ });
  draft.click();
  await waitForSolid(() =>
    expect(view.queryByRole("alert")?.textContent).toContain("Visibility command failed"),
  );
  expect(view.getByRole("button", { name: /Draft/ })).toBe(draft);
  expect(view.applied).not.toHaveBeenCalled();
  draft.click();
  await waitForSolid(() => {
    expect(view.queryByRole("alert")).toBeNull();
    expect(draft.hasAttribute("disabled")).toBe(true);
  });
  retry.resolve({ status: "success" });
  await waitForSolid(() => expect(view.applied).toHaveBeenCalledOnce());
  expect(view.getByRole("button", { name: /Draft/ })).toBe(draft);
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
    view.getByRole("button", { name: /Draft/ }).click();
    await waitForSolid(() => {
      expect(view.getByRole("button", { name: /Draft/ }).hasAttribute("disabled")).toBe(true);
    });
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
        expect(view.getByRole("button", { name: /Read-only/ }).getAttribute("aria-pressed")).toBe(
          "true",
        );
        expect(view.getByRole("button", { name: /Draft/ }).hasAttribute("disabled")).toBe(false);
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
  expect(view.getByText("Session members")).toBeDefined();
  const permission = view.getByRole("checkbox", { name: "Pat Member, Visitor" });
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
  await waitForSolid(() => expect(permission.getAttribute("aria-disabled")).toBeNull());
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

it("reads native permission readiness and retains people through refresh and failure", async () => {
  const initial = prepared();
  const read = createDeferred();
  const [source, setSource] = createSignal(
    prepared({ state: { loading: false, read: read.promise } }),
  );
  const view = mountSolid(() => {
    const adapter = createChatSessionSharingMobileAdapter(source, {
      onOpenSharing: vi.fn(),
      onOpenAccess: vi.fn(),
      onApplied: vi.fn(),
      accessTarget: () => undefined,
    });
    return <ChatSessionSharingMobile {...adapter.sharing} />;
  });
  expect(view.getByRole("status", { name: "Loading…" }).getAttribute("aria-busy")).toBe("true");
  expect(view.queryByRole("checkbox", { name: /^Pat Member,/ })).toBeNull();
  setSource(initial);
  read.resolve();
  await waitForSolid(() =>
    expect(view.queryByRole("checkbox", { name: /^Pat Member,/ })).not.toBeNull(),
  );
  const person = view.getByRole("checkbox", { name: /^Pat Member,/ });
  expect(view.queryByRole("status", { name: "Loading…" })).toBeNull();
  const refresh = createDeferred();
  setSource({ ...initial, state: { ...initial.state!, loading: true, read: refresh.promise } });
  flush();
  expect(view.getByRole("checkbox", { name: /^Pat Member,/ })).toBe(person);
  expect(person.getAttribute("aria-disabled")).toBe("true");
  expect(view.queryByRole("status", { name: "Loading…" })).toBeNull();
  setSource({
    ...initial,
    state: { ...initial.state!, loading: false, error: "Permission refresh failed" },
  });
  refresh.resolve();
  await waitForSolid(() => expect(view.queryByRole("alert")).not.toBeNull());
  expect(view.getByRole("alert").textContent).toContain("Permission refresh failed");
  expect(view.getByRole("checkbox", { name: /^Pat Member,/ })).toBe(person);
});
