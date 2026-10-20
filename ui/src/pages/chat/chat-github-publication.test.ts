/* @vitest-environment jsdom */
import { createComponent, flush } from "solid-js";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { GatewayRequestError } from "../../api/gateway.ts";
import type {
  GitHubPublicationOptions,
  GitHubPublicationView,
} from "../../lib/sessions/github-publication-owner.ts";
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
const personal: typeof interrupted.result.publisher = { source: "personal", ...account };
const published = { requestId, status: "published", publisher: shared };
const pendingOptions = { ...options, pendingPersonal: interrupted };
async function prepare(initialOptions = options) {
  const test = setup(initialOptions);
  const ready = await settled(test.controller);
  const act = (
    action: "onPublish" | "onConfirm" | "onRefresh" | "onNewAction",
    response?: unknown,
  ) => {
    if (response !== undefined) {
      test.request.mockImplementationOnce(() =>
        response instanceof Error ? Promise.reject(response) : Promise.resolve(response),
      );
    }
    test.controller.view()?.[action]?.();
    return settled(test.controller);
  };
  return { ...test, ready, act };
}
function renderAction(controller: PublicationController) {
  const container = document.createElement("div");
  mountSolid(() => createComponent(GitHubPublicationAction, { publication: controller.view()! }), {
    container,
  });
  flush();
  return container;
}

it("does not present an accepted publication status read as a new write", async () => {
  const { controller, request, ready, act } = await prepare();
  ready.onSelect?.("personal");
  const receipt = { ...accepted(), publisher: personal };
  const pending = await act("onPublish", receipt);
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
  const { request, ready, act } = await prepare();
  expect(ready.selection).toEqual({ source: "shared", expected: shared });
  ready.onSelect?.("shared");
  request.mockImplementationOnce(async (_method, params) => {
    throw selectionRejected(params.idempotencyKey, "Review the current publisher.");
  });
  const rejected = await act("onPublish");
  const first = request.mock.calls.at(-1)![1];
  expect(rejected).toMatchObject({
    locked: false,
    options: null,
    selection: null,
    error: "Review the current publisher.",
  });
  const next = { ...options, shared: { ...shared, accountId: 3, login: "new-shared" } };
  const refreshed = await act("onRefresh", next);
  expect(publications(request)).toHaveLength(1);
  refreshed.onSelect?.("shared");
  await act("onPublish", accepted());
  const second = request.mock.calls.at(-1)![1];
  expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
  expect(second.selection).toEqual({ source: "shared", expected: next.shared });
});

it.each(["uncertain-retry", "wrong-key"])(
  "retains the exact attempt for %s instead of inferring admission from error prose",
  async (mode) => {
    const { request, ready, act } = await prepare();
    ready.onSelect?.("personal");
    const reject = async (_method: string, params: { idempotencyKey: string }) => {
      throw selectionRejected(
        mode === "wrong-key" ? "other-key" : params.idempotencyKey,
        "GitHub publication identity changed.",
      );
    };
    if (mode === "uncertain-retry") {
      request.mockRejectedValueOnce(
        new Error("Response lost while the original invocation may still be preparing."),
      );
    } else {
      request.mockImplementationOnce(reject);
    }
    await act("onPublish");
    const first = request.mock.calls.at(-1)![1];
    expect(first).toMatchObject({ selection: { source: "personal", generation, account } });
    request.mockImplementationOnce(reject);
    const retained = await act("onPublish");
    expect(retained).toMatchObject({ locked: true, onSelect: undefined, onNewAction: undefined });
    expect(request.mock.calls.at(-1)![1]).toEqual(first);
  },
);

it("keeps a failed confirmation frozen until the server supplies a terminal outcome", async () => {
  const { request, act } = await prepare(pendingOptions);
  const unknown = await act("onConfirm", new Error("Confirmation response lost"));
  expect(unknown).toMatchObject({ locked: true, onNewAction: undefined });
  expect(unknown.confirmation).toEqual(confirmation);
  const failed = await act("onRefresh", {
    ...interrupted,
    result: {
      ...interrupted.result,
      status: "failed",
      code: "workspace_changed",
      nextAction: "Review the workspace before creating a new publication.",
    },
    confirmation: null,
  });
  expect(request).toHaveBeenLastCalledWith("sessions.github.status", { ...target, requestId });
  expect(failed).toMatchObject({ onConfirm: undefined, onNewAction: expect.any(Function) });
});

it.each(["options", "result", "selection-rejection"])(
  "retires an old %s response after ownership changes",
  async (outcome) => {
    const { controller, request, scope, ready } = await prepare();
    const discovering = outcome === "options";
    if (!discovering) {
      ready.onSelect?.("personal");
    }
    const old = createDeferred<
      GitHubPublicationOptions | NonNullable<GitHubPublicationView["result"]>
    >();
    request.mockReturnValueOnce(old.promise);
    controller.view()?.[discovering ? "onRefresh" : "onPublish"]?.();
    const first = request.mock.calls.at(-1)![1];
    if (!discovering) {
      controller.reset();
    }
    const next = discovering
      ? { ...options, shared: { ...shared, login: "other-system" }, personal: null }
      : pendingOptions;
    request.mockResolvedValueOnce(next);
    controller.sync({
      ...scope,
      key: discovering ? "gateway:bob:session:2" : "gateway:alice:session:2",
    });
    await settled(controller);
    if (outcome === "selection-rejection") {
      old.reject(selectionRejected(first.idempotencyKey, "Old selection rejected."));
    } else {
      old.resolve(
        discovering ? pendingOptions : { requestId, status: "published", publisher: personal },
      );
    }
    await Promise.resolve();
    if (discovering) {
      expect(controller.view()?.options).toEqual(next);
      expect(controller.view()?.result).toBeNull();
    } else {
      expect(controller.view()?.result?.status).toBe("needs_confirmation");
      expect(publications(request)).toHaveLength(1);
    }
  },
);

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
      response.resolve(published);
    } else {
      response.reject(
        outcome === "selection-rejection"
          ? selectionRejected(first.idempotencyKey, "Publication response")
          : new GatewayRequestError({ code: "UNAVAILABLE", message: "Publication response" }),
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
      expect(visible.result).toMatchObject(published);
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

it("keeps a sole personal account unselected until its labeled publish button is clicked", async () => {
  const unbound = await prepare({ ...options, personal: null });
  expect(unbound.ready.selection).toEqual({ source: "shared", expected: shared });
  const personalOnly = await prepare({ ...options, shared: null });
  expect(personalOnly.ready.selection).toBeNull();
  personalOnly.request.mockResolvedValueOnce(accepted());
  const container = renderAction(personalOnly.controller);
  expect(container.querySelector('[aria-label="Publication account"]')).toBeNull();
  const button = container.querySelector<HTMLButtonElement>(".chat-pr__create");
  expect(button?.textContent?.trim()).toBe("Publish as @alice-tools");
  expect(personalOnly.request).toHaveBeenCalledTimes(1);
  button?.click();
  await settled(personalOnly.controller);
  expect(personalOnly.request).toHaveBeenLastCalledWith("sessions.github.publish", {
    ...target,
    idempotencyKey: expect.any(String),
    selection: { source: "personal", account, generation },
  });
});

it("does not confirm a personal receipt with shared-only publication access", async () => {
  const { controller, request, scope, ready } = await prepare(pendingOptions);
  expect(ready.onConfirm).toBeTypeOf("function");
  controller.sync({ ...scope, canPublishPersonal: false });
  expect(controller.view()?.onConfirm).toBeUndefined();
  ready.onConfirm?.();
  expect(request.mock.calls.some(([method]) => method === "sessions.github.confirm")).toBe(false);
});

it("retires a new shared publication action when refreshed options withdraw the target", async () => {
  const { controller, request, scope } = await prepare();
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
  const { controller, request, scope, act } = await prepare();
  controller.sync({
    ...scope,
    key: "reader",
    canPublishShared: false,
    canPublishPersonal: false,
  });
  const reader = await settled(controller);
  expect(reader).toMatchObject({ onSelect: undefined, onPublish: undefined });
  controller.sync({ ...scope, key: "remote", personalReady: false });
  (await settled(controller)).onSelect?.("personal");
  controller.view()?.onPublish?.();
  expect(request.mock.calls.some(([method]) => method === "sessions.github.publish")).toBe(false);
  controller.view()?.onSelect?.("shared");
  await act("onPublish", {
    ...accepted(),
    publisher: shared,
    message: "Waiting for reconciliation.",
  });
  expect(request).toHaveBeenLastCalledWith(
    "sessions.github.publish",
    expect.objectContaining({ selection: { source: "shared", expected: shared } }),
  );
});
it("does not let an old terminal acknowledgement release a newer uncertain attempt", async () => {
  const { controller, request, act } = await prepare();
  const terminal = await act("onPublish", published);
  await act("onNewAction");
  const unknown = await act("onPublish", new Error("Response lost"));
  const calls = request.mock.calls.length;
  terminal.onNewAction?.();
  expect(controller.view()).toMatchObject({
    locked: true,
    error: unknown.error,
    selection: unknown.selection,
  });
  expect(request).toHaveBeenCalledTimes(calls);
  await act("onPublish");
  const callsToPublish = publications(request);
  expect(callsToPublish.at(-1)).toEqual(callsToPublish.at(-2));
});

it("does not let a saved confirmation confirm a different publication", async () => {
  const { request, ready: original, act } = await prepare(pendingOptions);
  expect(original.onPublish).toBeUndefined();
  expect(request).toHaveBeenCalledTimes(1);
  await act("onConfirm", { requestId, status: "published", publisher: personal });
  (await act("onNewAction", options)).onSelect?.("personal");
  const next = {
    ...interrupted,
    result: { ...interrupted.result, requestId: "bdca439a-e787-4f9f-b5f3-a878c662cc78" },
    confirmation: { ...confirmation, requestDigest: "b".repeat(64) },
  };
  request.mockResolvedValueOnce(next.result).mockResolvedValueOnce(next);
  const reviewed = await act("onPublish");
  expect(reviewed.confirmation).toEqual(next.confirmation);
  const calls = request.mock.calls.length;
  original.onConfirm?.();
  expect(request).toHaveBeenCalledTimes(calls);
  await act("onConfirm", { ...next.result, status: "requested" });
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
