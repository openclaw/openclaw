/* @vitest-environment jsdom */

import { createMemo, createSignal, Show } from "solid-js";
import { expect, it, vi } from "vitest";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import {
  GitHubPublicationOwner,
  type GitHubPublicationPresentationBinding,
} from "../../../lib/sessions/github-publication-owner.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../../test-helpers/gateway-client.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { options, requestId, shared } from "../chat-github-publication.test-support.ts";
import { GitHubPublicationMobile } from "./chat-github-publication-mobile.tsx";

const published = {
  status: "published",
  requestId,
  publisher: shared,
  repository: "example/project",
  branch: "feature/docs",
  url: "https://github.com/example/project/pull/1",
};

function bind(request: GatewayRequestHandler) {
  const owner = new GitHubPublicationOwner({
    client: createTestGatewayClient(request),
    target: { sessionKey: "agent:main:publication", agentId: "main" },
    isCurrent: () => true,
    reserve: () => {},
    release: () => {},
    unbound: () => {},
  });
  const binding = owner.bind();
  binding.sync({
    canPublishShared: true,
    canPublishPersonal: true,
    personalReady: true,
    isCurrent: () => true,
    isPresented: () => true,
  });
  return { owner, binding };
}

function render(binding: GitHubPublicationPresentationBinding) {
  let replace!: (binding: GitHubPublicationPresentationBinding) => void;
  const view = mountSolid(() => {
    const [current, setCurrent] = createSignal(binding);
    replace = setCurrent;
    const projection = createMemo(() => projectOwner(current(), (source) => source.view()));
    return (
      <Show when={projection().read()}>
        {(publication) => <GitHubPublicationMobile publication={publication()} presented />}
      </Show>
    );
  });
  const button = () => view.container.querySelector<HTMLButtonElement>(".chat-pr__create");
  const expectButton = (label: string, disabled = true) =>
    waitForSolid(() => {
      expect(button()?.disabled).toBe(disabled);
      expect(button()?.textContent).toContain(label);
    });
  return { ...view, replace, expectButton };
}

it("observes a delayed owner read and retries its visible discovery failure once", async () => {
  const initial = Promise.withResolvers<unknown>();
  const request = vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValue(options);
  const { binding } = bind(request);
  const view = render(binding);
  await view.expectButton("Loading");
  initial.reject(new Error("Discovery unavailable"));
  await waitForSolid(() => expect(view.container.textContent).toContain("Discovery unavailable"));
  view.getByRole("button", { name: "Refresh publication" }).click();
  await view.expectButton("Publish PR", false);
  expect(view.container.textContent).not.toContain("Discovery unavailable");
  expect(request).toHaveBeenCalledTimes(2);
  binding.detach();
});

it("retires a held publication before displaying a replacement binding", async () => {
  const completion = Promise.withResolvers<unknown>();
  const request = vi.fn().mockResolvedValueOnce(options).mockReturnValueOnce(completion.promise);
  const first = bind(request);
  const view = render(first.binding);
  await waitForSolid(() => expect(view.getByRole("button", { name: "Publish PR" })).toBeTruthy());
  view.getByRole("button", { name: "Publish PR" }).click();
  await view.expectButton("Publishing");
  const nextRead = Promise.withResolvers<unknown>();
  const next = bind(vi.fn().mockReturnValue(nextRead.promise));
  first.binding.detach();
  first.owner.reset();
  view.replace(next.binding);
  await view.expectButton("Loading");
  expect(view.queryByRole("button", { name: "Publish PR" })).toBeNull();
  completion.resolve(published);
  await view.expectButton("Loading");
  expect(view.container.querySelector(`a[href="${published.url}"]`)).toBeNull();
  nextRead.resolve({ ...options, shared: { ...shared, login: "replacement-bot" } });
  await view.expectButton("Publish PR", false);
  next.binding.detach();
});

it("acknowledges a completed publication before reading the next action", async () => {
  const nextRead = Promise.withResolvers<unknown>();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ ...options, latestShared: { result: published, confirmation: null } })
    .mockReturnValueOnce(nextRead.promise);
  const { binding } = bind(request);
  const view = render(binding);
  await waitForSolid(() => expect(view.getByRole("link", { name: "Open PR" })).toBeTruthy());
  expect(view.queryByRole("button", { name: "Publish PR" })).toBeNull();
  view.getByRole("button", { name: "Dismiss" }).click();
  await view.expectButton("Loading");
  expect(view.queryByRole("link", { name: "Open PR" })).toBeNull();
  nextRead.resolve(options);
  await waitForSolid(() => expect(view.getByRole("button", { name: "Publish PR" })).toBeTruthy());
  binding.detach();
});
