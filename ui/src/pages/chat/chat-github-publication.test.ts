/* @vitest-environment jsdom */
import { createComponent, flush } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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

type PublicationController = ReturnType<typeof setup>["controller"];
const target = { sessionKey: "agent:main:one", agentId: "main" };
const publications = (request: ReturnType<typeof setup>["request"]) =>
  request.mock.calls.filter(([method]) => method === "sessions.github.publish");
const selectionRejected = (idempotencyKey: string, message: string) =>
  new GatewayRequestError({
    code: "UNAVAILABLE",
    message,
    details: { code: "GITHUB_PUBLICATION_SELECTION_REJECTED", idempotencyKey },
  });
const accepted = () => ({ requestId, status: "requested", message: "Accepted." });
function renderAction(controller: PublicationController) {
  const container = document.createElement("div");
  mountSolid(() => createComponent(GitHubPublicationAction, { publication: controller.view()! }), {
    container,
  });
  flush();
  return container;
}

describe("explicit GitHub publication", () => {
  it("does not present an accepted publication status read as a new write", async () => {
    const { controller, request } = setup();
    (await settled(controller)).onSelect?.("personal");
    const receipt = { ...accepted(), publisher: { source: "personal", ...account } };
    request.mockResolvedValueOnce(receipt);
    controller.view()?.onPublish?.();
    const pending = await settled(controller);
    const status = createDeferred<unknown>();
    request.mockImplementationOnce(() => status.promise);
    pending.onRefresh();
    onTestFinished(async () => {
      status.resolve({ result: receipt, confirmation: null });
      await settled(controller);
    });
    const container = renderAction(controller);
    expect(container.textContent).not.toContain("Publishing");
    expect(container.querySelector<HTMLButtonElement>(".chat-pr__create")?.disabled).toBe(true);
    expect(request).toHaveBeenLastCalledWith("sessions.github.status", { ...target, requestId });
    expect(publications(request)).toHaveLength(1);
  });

  it("releases only a rejected first shared invocation for a fresh explicit choice", async () => {
    const { controller, request } = setup();
    const ready = await settled(controller);
    expect(ready.selection).toEqual({ source: "shared", expected: shared });
    ready.onSelect?.("shared");
    request.mockImplementationOnce(async (_method, params) => {
      throw selectionRejected(params.idempotencyKey, "Review the current publisher.");
    });
    controller.view()?.onPublish?.();
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
    rejected.onRefresh();
    const refreshed = await settled(controller);
    expect(publications(request)).toHaveLength(1);
    refreshed.onSelect?.("shared");
    request.mockResolvedValueOnce(accepted());
    controller.view()?.onPublish?.();
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
        throw selectionRejected(
          mode === "wrong-key" ? "other-key" : params.idempotencyKey,
          "GitHub publication identity changed.",
        );
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
      controller.view()?.onPublish?.();
      await settled(controller);
      const first = request.mock.calls.at(-1)![1];
      expect(first).toMatchObject({ selection: { source: "personal", generation, account } });
      request.mockImplementationOnce(reject);
      controller.view()?.onPublish?.();
      const retained = await settled(controller);
      expect(retained).toMatchObject({ locked: true, onSelect: undefined, onNewAction: undefined });
      expect(request.mock.calls.at(-1)![1]).toEqual(first);
    },
  );

  it("keeps a failed confirmation frozen until the server supplies a terminal outcome", async () => {
    const { controller, request } = setup({ ...options, pendingPersonal: interrupted });
    const view = await settled(controller);
    request.mockRejectedValueOnce(new Error("Confirmation response lost"));
    view.onConfirm?.();
    const unknown = await settled(controller);
    expect(unknown).toMatchObject({ locked: true, onNewAction: undefined });
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
    unknown.onRefresh();
    const failed = await settled(controller);
    expect(request).toHaveBeenLastCalledWith("sessions.github.status", { ...target, requestId });
    expect(failed.onConfirm).toBeUndefined();
    expect(failed.onNewAction).toBeTypeOf("function");
  });

  it("drops old options after an ownership change without exposing the old personal request", async () => {
    const { controller, request, scope } = setup();
    await settled(controller);
    const old = createDeferred<GitHubPublicationOptions>();
    request.mockReturnValueOnce(old.promise);
    controller.view()?.onRefresh();
    const nextOptions = {
      shared: { ...shared, login: "other-system" },
      personal: null,
      pendingPersonal: null,
      latestShared: null,
    };
    request.mockResolvedValueOnce(nextOptions);
    controller.sync({ ...scope, key: "gateway:bob:session:2" });
    await settled(controller);
    old.resolve({ ...options, pendingPersonal: interrupted });
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
      ready.onPublish?.();
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
      ready.onPublish?.();
      ready.onSelect?.("personal");
      ready.onRefresh();
      expect(request).toHaveBeenCalledTimes(2);
      presented = true;
      controller.sync(retainedScope);
      const visible = await settled(controller);
      expect(request).toHaveBeenCalledTimes(2);
      if (outcome === "published") {
        expect(visible.result).toMatchObject({ requestId, publisher: shared, status: "published" });
        presented = false;
        visible.onNewAction?.();
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
      const old = createDeferred<unknown>();
      request.mockReturnValueOnce(old.promise);
      controller.view()?.onPublish?.();
      const first = request.mock.calls.at(-1)![1];
      controller.reset();
      request.mockResolvedValueOnce({ ...options, pendingPersonal: interrupted });
      controller.sync({ ...scope, key: "gateway:alice:session:2" });
      await settled(controller);
      if (outcome === "result") {
        old.resolve({
          requestId,
          status: "published",
          publisher: { source: "personal", ...account },
        });
      } else {
        old.reject(selectionRejected(first.idempotencyKey, "Old selection rejected."));
      }
      await Promise.resolve();
      expect(controller.view()?.result?.status).toBe("needs_confirmation");
      expect(publications(request)).toHaveLength(1);
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
    personalOnly.request.mockResolvedValueOnce(accepted());
    const container = renderAction(personalOnly.controller);
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
  });

  it("does not confirm a personal receipt with shared-only publication access", async () => {
    const { controller, request, scope } = setup({ ...options, pendingPersonal: interrupted });
    const staff = await settled(controller);
    expect(staff.onConfirm).toBeTypeOf("function");
    controller.sync({ ...scope, canPublishPersonal: false });
    expect(controller.view()?.onConfirm).toBeUndefined();
    staff.onConfirm?.();
    expect(request.mock.calls.some(([method]) => method === "sessions.github.confirm")).toBe(false);
  });

  it("retires a new shared publication action when refreshed options withdraw the target", async () => {
    const { controller, request, scope } = setup();
    await settled(controller);
    controller.sync({ ...scope, canPublishPersonal: false });
    const response = createDeferred<GitHubPublicationOptions>();
    request.mockReturnValueOnce(response.promise);
    controller.view()?.onRefresh();
    const refreshing = controller.view()!;
    expect(refreshing.onPublish).toBeTypeOf("function");
    response.resolve({ ...options, shared: null, personal: null });
    expect((await settled(controller)).onPublish).toBeUndefined();
    refreshing.onPublish?.();
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
    controller.view()?.onPublish?.();
    expect(request.mock.calls.some(([method]) => method === "sessions.github.publish")).toBe(false);
    controller.view()?.onSelect?.("shared");
    request.mockResolvedValueOnce({
      requestId,
      status: "requested",
      publisher: shared,
      message: "Waiting for reconciliation.",
    });
    controller.view()?.onPublish?.();
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
    (await settled(controller)).onPublish?.();
    const terminal = await settled(controller);
    terminal.onNewAction?.();
    const next = await settled(controller);
    request.mockRejectedValueOnce(new Error("Response lost"));
    next.onPublish?.();
    const unknown = await settled(controller);
    const calls = request.mock.calls.length;
    terminal.onNewAction?.();
    expect(controller.view()).toMatchObject({
      locked: true,
      error: unknown.error,
      selection: unknown.selection,
    });
    expect(request).toHaveBeenCalledTimes(calls);
    controller.view()?.onPublish?.();
    await settled(controller);
    const callsToPublish = publications(request);
    expect(callsToPublish.at(-1)).toEqual(callsToPublish.at(-2));
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
    original.onConfirm?.();
    const terminal = await settled(controller);
    request.mockResolvedValueOnce(options);
    terminal.onNewAction?.();
    (await settled(controller)).onSelect?.("personal");
    const next = {
      ...interrupted,
      result: { ...interrupted.result, requestId: "bdca439a-e787-4f9f-b5f3-a878c662cc78" },
      confirmation: { ...confirmation, requestDigest: "b".repeat(64) },
    };
    request.mockResolvedValueOnce(next.result).mockResolvedValueOnce(next);
    controller.view()?.onPublish?.();
    const reviewed = await settled(controller);
    expect(reviewed.confirmation).toEqual(next.confirmation);
    const calls = request.mock.calls.length;
    original.onConfirm?.();
    expect(request).toHaveBeenCalledTimes(calls);
    request.mockResolvedValueOnce({ ...next.result, status: "requested" });
    reviewed.onConfirm?.();
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
