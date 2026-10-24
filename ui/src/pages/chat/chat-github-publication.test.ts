/* @vitest-environment jsdom */
import { createComponent, flush } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GitHubPublicationOptions } from "../../lib/sessions/github-publication-owner.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  account,
  confirmation,
  generation,
  interrupted,
  options,
  requestId,
  setup,
  settled,
  shared,
} from "./chat-github-publication.test-support.ts";
import { GitHubPublicationAction } from "./components/chat-github-publication.tsx";

describe("explicit GitHub publication", () => {
  it("notifies sibling presentations only after freezing the admitted account", async () => {
    const { controller, request, changed } = setup();
    const ready = await settled(controller);
    const response = createDeferred<unknown>();
    request.mockReturnValueOnce(response.promise);
    const snapshots: unknown[] = [];
    changed.mockImplementation(() => {
      const view = controller.view()!;
      snapshots.push({ activity: view.activity, locked: view.locked, onSelect: view.onSelect });
    });
    const completion = ready.onPublish?.();
    expect(snapshots).toEqual([{ activity: "publish", locked: true, onSelect: undefined }]);
    response.resolve({ requestId, status: "requested", publisher: shared });
    await completion;
  });

  it("does not present an accepted publication status read as a new write", async () => {
    const { controller, request } = setup();
    (await settled(controller)).onSelect?.("personal");
    const accepted = {
      requestId,
      publisher: { source: "personal", ...account },
      status: "requested",
      message: "Accepted.",
    };
    request.mockResolvedValueOnce(accepted);
    void controller.view()?.onPublish?.();
    const pending = await settled(controller);
    const status = createDeferred<unknown>();
    request.mockImplementationOnce(() => status.promise);
    void pending.onRefresh();
    const container = document.createElement("div");
    let unmount: (() => void) | undefined;
    try {
      unmount = mountSolid(
        () => createComponent(GitHubPublicationAction, { publication: controller.view()! }),
        { container },
      ).unmount;
      flush();
      expect(container.textContent).not.toContain("Publishing");
      expect(container.querySelector<HTMLButtonElement>(".chat-pr__create")?.disabled).toBe(true);
      expect(request).toHaveBeenLastCalledWith("sessions.github.status", {
        sessionKey: "agent:main:one",
        agentId: "main",
        requestId,
      });
      expect(
        request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
      ).toHaveLength(1);
    } finally {
      status.resolve({ result: accepted, confirmation: null });
      await settled(controller);
      unmount?.();
    }
  });

  it("releases only a rejected first shared invocation for a fresh explicit choice", async () => {
    const { controller, request } = setup();
    const ready = await settled(controller);
    expect(ready.selection).toEqual({ source: "shared", expected: shared });
    ready.onSelect?.("shared");
    request.mockImplementationOnce(async (_method, params) => {
      throw new GatewayRequestError({
        code: "UNAVAILABLE",
        message: "Review the current publisher.",
        details: {
          code: "GITHUB_PUBLICATION_SELECTION_REJECTED",
          idempotencyKey: params.idempotencyKey,
        },
      });
    });
    void controller.view()?.onPublish?.();
    const rejected = await settled(controller);
    const first = request.mock.calls.at(-1)![1];
    expect(rejected).toMatchObject({
      locked: false,
      options: null,
      selection: null,
      error: "Review the current publisher.",
    });
    const next = {
      ...options,
      shared: { ...shared, accountId: 3, login: "new-shared" },
    };
    request.mockResolvedValueOnce(next);
    void rejected.onRefresh();
    const refreshed = await settled(controller);
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
    ).toHaveLength(1);
    refreshed.onSelect?.("shared");
    request.mockResolvedValueOnce({ requestId, status: "requested", message: "Accepted." });
    void controller.view()?.onPublish?.();
    await settled(controller);
    const second = request.mock.calls.at(-1)![1];
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(second.selection).toEqual({ source: "shared", expected: next.shared });
  });

  it.each(["uncertain-retry", "wrong-key"])(
    "retains the exact attempt for %s instead of inferring admission from error prose",
    async (mode) => {
      const { controller, request } = setup();
      (await settled(controller)).onSelect?.("personal");
      const reject = async (_method: string, params: { idempotencyKey: string }) => {
        throw new GatewayRequestError({
          code: "UNAVAILABLE",
          message: "GitHub publication identity changed.",
          details: {
            code: "GITHUB_PUBLICATION_SELECTION_REJECTED",
            idempotencyKey: mode === "wrong-key" ? "other-key" : params.idempotencyKey,
          },
        });
      };
      request.mockImplementationOnce(
        mode === "uncertain-retry"
          ? async () => {
              throw new Error(
                "Response lost while the original invocation may still be preparing.",
              );
            }
          : reject,
      );
      void controller.view()?.onPublish?.();
      await settled(controller);
      const first = request.mock.calls.at(-1)![1];
      expect(first).toMatchObject({ selection: { source: "personal", generation, account } });
      request.mockImplementationOnce(reject);
      void controller.view()?.onPublish?.();
      const retained = await settled(controller);
      expect(retained.locked).toBe(true);
      expect(retained.onSelect).toBeUndefined();
      expect(retained.onNewAction).toBeUndefined();
      expect(request.mock.calls.at(-1)![1]).toEqual(first);
    },
  );

  it("keeps a failed confirmation frozen until the server supplies a terminal outcome", async () => {
    const { controller, request } = setup({ ...options, pendingPersonal: interrupted });
    const view = await settled(controller);
    request.mockRejectedValueOnce(new Error("Confirmation response lost"));
    void view.onConfirm?.();
    const unknown = await settled(controller);
    expect(unknown.locked).toBe(true);
    expect(unknown.onNewAction).toBeUndefined();
    expect(unknown.confirmation).toEqual(confirmation);
    request.mockResolvedValueOnce({
      ...interrupted,
      result: {
        ...interrupted.result,
        status: "failed",
        code: "workspace_changed",
        nextAction: "Review the workspace before creating a new publication.",
      },
      confirmation: null,
    });
    void unknown.onRefresh();
    const failed = await settled(controller);
    expect(request).toHaveBeenLastCalledWith("sessions.github.status", {
      sessionKey: "agent:main:one",
      agentId: "main",
      requestId,
    });
    expect(failed.onConfirm).toBeUndefined();
    expect(failed.onNewAction).toBeTypeOf("function");
  });

  it("drops old options after an ownership change without exposing the old personal request", async () => {
    const { controller, request, scope } = setup();
    await settled(controller);
    let resolveOld!: (value: GitHubPublicationOptions) => void;
    request.mockImplementationOnce(
      () =>
        new Promise<GitHubPublicationOptions>((resolve) => {
          resolveOld = resolve;
        }),
    );
    void controller.view()?.onRefresh();
    const nextOptions = {
      shared: { ...shared, login: "other-system" },
      personal: null,
      pendingPersonal: null,
      latestShared: null,
    };
    request.mockResolvedValueOnce(nextOptions);
    controller.sync({ ...scope, key: "gateway:bob:session:2" });
    await settled(controller);
    resolveOld({ ...options, pendingPersonal: interrupted });
    await Promise.resolve();
    expect(controller.view()?.options).toEqual(nextOptions);
    expect(controller.view()?.result).toBeNull();
  });

  it.each(["published", "unknown", "selection-rejection"] as const)(
    "retains a %s response that arrives while the pane is hidden",
    async (outcome) => {
      const { controller, request, scope, changed } = setup();
      let presented = true;
      const retainedScope = { ...scope, isPresented: () => presented };
      controller.sync(retainedScope);
      const ready = await settled(controller);
      const response = createDeferred<unknown>();
      request.mockImplementationOnce(() => response.promise);
      void ready.onPublish?.();
      const first = request.mock.calls.at(-1)![1];
      presented = false;
      controller.sync(retainedScope);
      changed.mockClear();
      if (outcome === "published") {
        response.resolve({ requestId, publisher: shared, status: "published" });
      } else {
        response.reject(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Publication response",
            ...(outcome === "selection-rejection"
              ? {
                  details: {
                    code: "GITHUB_PUBLICATION_SELECTION_REJECTED",
                    idempotencyKey: first.idempotencyKey,
                  },
                }
              : {}),
          }),
        );
      }
      await vi.waitFor(() => expect(changed).toHaveBeenCalled());
      controller.sync(retainedScope);
      expect(controller.view()).toBeUndefined();
      void ready.onPublish?.();
      ready.onSelect?.("personal");
      void ready.onRefresh();
      expect(request).toHaveBeenCalledTimes(2);
      presented = true;
      controller.sync(retainedScope);
      const visible = await settled(controller);
      expect(request).toHaveBeenCalledTimes(2);
      if (outcome === "published") {
        expect(visible.result).toMatchObject({ requestId, publisher: shared, status: "published" });
        presented = false;
        void visible.onNewAction?.();
        presented = true;
        expect(controller.view()?.result).toEqual(visible.result);
      } else {
        expect(visible.error).toContain("Publication response");
        expect(visible.locked).toBe(outcome === "unknown");
        expect(visible.selection).toEqual(outcome === "unknown" ? first.selection : null);
      }
    },
  );

  it.each(["result", "selection-rejection"])(
    "retires an old publication %s after reconnect without clearing the discovered request",
    async (outcome) => {
      const { controller, request, scope } = setup();
      (await settled(controller)).onSelect?.("personal");
      let resolveOld!: (value: unknown) => void;
      let rejectOld!: (error: unknown) => void;
      request.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            resolveOld = resolve;
            rejectOld = reject;
          }),
      );
      void controller.view()?.onPublish?.();
      const first = request.mock.calls.at(-1)![1];
      controller.reset();
      request.mockResolvedValueOnce({ ...options, pendingPersonal: interrupted });
      controller.sync({ ...scope, key: "gateway:alice:session:2" });
      await settled(controller);
      if (outcome === "result") {
        resolveOld({
          requestId,
          status: "published",
          publisher: { source: "personal", ...account },
        });
      } else {
        rejectOld(
          new GatewayRequestError({
            code: "UNAVAILABLE",
            message: "Old selection rejected.",
            details: {
              code: "GITHUB_PUBLICATION_SELECTION_REJECTED",
              idempotencyKey: first.idempotencyKey,
            },
          }),
        );
      }
      await Promise.resolve();
      expect(controller.view()?.result?.status).toBe("needs_confirmation");
      expect(
        request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
      ).toHaveLength(1);
    },
  );

  it("keeps a sole personal account unselected until its labeled publish button is clicked", async () => {
    const unbound = setup({ shared, personal: null, pendingPersonal: null, latestShared: null });
    expect((await settled(unbound.controller)).selection).toEqual({
      source: "shared",
      expected: shared,
    });
    const personalOnly = setup({ ...options, shared: null });
    expect((await settled(personalOnly.controller)).selection).toBeNull();
    const container = document.createElement("div");
    let unmount: (() => void) | undefined;
    personalOnly.request.mockResolvedValueOnce({
      requestId,
      status: "requested",
      message: "Accepted.",
    });
    try {
      unmount = mountSolid(
        () =>
          createComponent(GitHubPublicationAction, {
            publication: personalOnly.controller.view()!,
          }),
        { container },
      ).unmount;
      flush();
      expect(container.querySelector('[aria-label="Publication account"]')).toBeNull();
      const button = container.querySelector<HTMLButtonElement>(".chat-pr__create");
      expect(button?.textContent?.trim()).toBe("Publish as @alice-tools");
      expect(personalOnly.request).toHaveBeenCalledTimes(1);
      button?.click();
      await settled(personalOnly.controller);
      expect(personalOnly.request).toHaveBeenLastCalledWith("sessions.github.publish", {
        sessionKey: "agent:main:one",
        agentId: "main",
        idempotencyKey: expect.any(String),
        selection: { source: "personal", account, generation },
      });
    } finally {
      unmount?.();
    }
  });

  it("does not confirm a personal receipt with shared-only publication access", async () => {
    const { controller, request, scope } = setup({ ...options, pendingPersonal: interrupted });
    const staff = await settled(controller);
    expect(staff.onConfirm).toBeTypeOf("function");
    controller.sync({ ...scope, canPublishPersonal: false });
    expect(controller.view()?.onConfirm).toBeUndefined();
    void staff.onConfirm?.();
    expect(request.mock.calls.some(([method]) => method === "sessions.github.confirm")).toBe(false);
  });

  it("retires a new shared publication action when refreshed options withdraw the target", async () => {
    const { controller, request, scope } = setup();
    await settled(controller);
    controller.sync({ ...scope, canPublishPersonal: false });
    const response = createDeferred<GitHubPublicationOptions>();
    request.mockReturnValueOnce(response.promise);
    void controller.view()?.onRefresh();
    const refreshing = controller.view()!;
    expect(refreshing.onPublish).toBeTypeOf("function");
    response.resolve({ ...options, shared: null, personal: null });
    expect((await settled(controller)).onPublish).toBeUndefined();
    void refreshing.onPublish?.();
    expect(request.mock.calls.some(([method]) => method === "sessions.github.publish")).toBe(false);
  });

  it("keeps readers nonmutating and personal publication unavailable on busy or remote workspaces", async () => {
    const { controller, request, scope } = setup();
    await settled(controller);
    controller.sync({
      ...scope,
      key: "reader",
      canPublishShared: false,
      canPublishPersonal: false,
    });
    const reader = await settled(controller);
    expect(reader.onSelect).toBeUndefined();
    expect(reader.onPublish).toBeUndefined();
    controller.sync({ ...scope, key: "remote", personalReady: false });
    (await settled(controller)).onSelect?.("personal");
    void controller.view()?.onPublish?.();
    expect(request.mock.calls.some(([method]) => method === "sessions.github.publish")).toBe(false);
    controller.view()?.onSelect?.("shared");
    request.mockResolvedValueOnce({
      requestId,
      status: "requested",
      publisher: shared,
      message: "Waiting for reconciliation.",
    });
    void controller.view()?.onPublish?.();
    await settled(controller);
    expect(request).toHaveBeenLastCalledWith(
      "sessions.github.publish",
      expect.objectContaining({ selection: { source: "shared", expected: shared } }),
    );
  });
});

describe("publication action observation", () => {
  it("does not let an old terminal acknowledgement release a newer uncertain attempt", async () => {
    const { controller, request } = setup();
    request.mockResolvedValueOnce({ requestId, status: "published", publisher: shared });
    void (await settled(controller)).onPublish?.();
    const terminal = await settled(controller);
    void terminal.onNewAction?.();
    const next = await settled(controller);
    request.mockRejectedValueOnce(new Error("Response lost"));
    void next.onPublish?.();
    const unknown = await settled(controller);
    const calls = request.mock.calls.length;
    void terminal.onNewAction?.();
    expect(controller.view()).toMatchObject({
      locked: true,
      error: unknown.error,
      selection: unknown.selection,
    });
    expect(request).toHaveBeenCalledTimes(calls);
    void controller.view()?.onPublish?.();
    await settled(controller);
    const publications = request.mock.calls.filter(
      ([method]) => method === "sessions.github.publish",
    );
    expect(publications.at(-1)).toEqual(publications.at(-2));
  });

  it("does not let a saved confirmation confirm a different publication", async () => {
    const { controller, request } = setup({ ...options, pendingPersonal: interrupted });
    const original = await settled(controller);
    expect(original.onPublish).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({
      requestId,
      status: "published",
      publisher: { source: "personal", ...account },
    });
    void original.onConfirm?.();
    const terminal = await settled(controller);
    request.mockResolvedValueOnce(options);
    void terminal.onNewAction?.();
    (await settled(controller)).onSelect?.("personal");
    const next = {
      ...interrupted,
      result: { ...interrupted.result, requestId: "bdca439a-e787-4f9f-b5f3-a878c662cc78" },
      confirmation: { ...confirmation, requestDigest: "b".repeat(64) },
    };
    request.mockResolvedValueOnce(next.result).mockResolvedValueOnce(next);
    void controller.view()?.onPublish?.();
    const reviewed = await settled(controller);
    expect(reviewed.confirmation).toEqual(next.confirmation);
    const calls = request.mock.calls.length;
    void original.onConfirm?.();
    expect(request).toHaveBeenCalledTimes(calls);
    request.mockResolvedValueOnce({ ...next.result, status: "requested" });
    void reviewed.onConfirm?.();
    await settled(controller);
    expect(request).toHaveBeenLastCalledWith(
      "sessions.github.confirm",
      expect.objectContaining({
        requestId: next.result.requestId,
        generation,
        account,
        requestDigest: next.confirmation.requestDigest,
      }),
    );
  });
});
