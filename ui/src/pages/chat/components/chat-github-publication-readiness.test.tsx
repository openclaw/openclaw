/* @vitest-environment jsdom */

import { createMemo, createSignal, Show } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import {
  GitHubPublicationOwner,
  type GitHubPublicationPresentationBinding,
} from "../../../lib/sessions/github-publication-owner.ts";
import {
  createTestGatewayClient,
  type GatewayRequestHandler,
} from "../../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../../test-helpers/solid-settle.ts";
import { options, requestId, shared } from "../chat-github-publication.test-support.ts";
import { GitHubPublicationMobile } from "./chat-github-publication-mobile.tsx";

afterEach(cleanupSolid);

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
  return { ...view, replace };
}

it("observes a delayed owner read and retries its visible discovery failure once", async () => {
  const initial = Promise.withResolvers<unknown>();
  const request = vi.fn().mockReturnValueOnce(initial.promise).mockResolvedValue(options);
  const { binding } = bind(request);
  const view = render(binding);
  const button = () => view.container.querySelector<HTMLButtonElement>(".chat-pr__create");
  await waitForSolid(() => {
    expect(button()?.disabled).toBe(true);
    expect(button()?.textContent).toContain("Loading");
  });
  expect(request).toHaveBeenCalledTimes(1);
  initial.reject(new Error("Discovery unavailable"));
  await waitForSolid(() => expect(view.container.textContent).toContain("Discovery unavailable"));
  expect(binding.view()).toMatchObject({
    optionsUnavailable: true,
    error: "Discovery unavailable",
  });
  view.container
    .querySelector<HTMLButtonElement>('button[aria-label="Refresh publication"]')!
    .click();
  await waitForSolid(() => {
    expect(button()?.disabled).toBe(false);
    expect(button()?.textContent).toContain("Publish PR");
  });
  expect(binding.view()).toMatchObject({ optionsUnavailable: false, error: null });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "sessions.github.options",
    "sessions.github.options",
  ]);
  binding.detach();
});

it("retires a held publication before displaying a replacement binding", async () => {
  const completion = Promise.withResolvers<unknown>();
  const request = vi.fn().mockResolvedValueOnce(options).mockReturnValueOnce(completion.promise);
  const first = bind(request);
  const view = render(first.binding);
  await waitForSolid(() => expect(view.getByRole("button", { name: "Publish PR" })).toBeTruthy());
  view.getByRole("button", { name: "Publish PR" }).click();
  await waitForSolid(() => {
    const button = view.container.querySelector<HTMLButtonElement>(".chat-pr__create");
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Publishing");
  });
  const nextRead = Promise.withResolvers<unknown>();
  const next = bind(vi.fn().mockReturnValue(nextRead.promise));
  first.binding.detach();
  first.owner.reset();
  view.replace(next.binding);
  await waitForSolid(() => {
    const button = view.container.querySelector<HTMLButtonElement>(".chat-pr__create");
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toContain("Loading");
    expect(view.queryByRole("button", { name: "Publish PR" })).toBeNull();
  });
  completion.resolve({
    status: "published",
    requestId,
    url: "https://github.com/example/repo/pull/1",
    repository: "example/repo",
    branch: "feature",
    publisher: shared,
  });
  await waitForSolid(() => {
    expect(
      view.container.querySelector<HTMLButtonElement>(".chat-pr__create")?.textContent,
    ).toContain("Loading");
    expect(
      view.container.querySelector('a[href="https://github.com/example/repo/pull/1"]'),
    ).toBeNull();
  });
  nextRead.resolve({ ...options, shared: { ...shared, login: "replacement-bot" } });
  await waitForSolid(() => {
    expect(view.getByRole("button", { name: "Publish PR" })).toBeTruthy();
    expect(view.container.querySelector<HTMLButtonElement>(".chat-pr__create")?.disabled).toBe(
      false,
    );
  });
  expect(request).toHaveBeenCalledTimes(2);
  next.binding.detach();
});

it("acknowledges a completed publication before reading the next action", async () => {
  const published = {
    status: "published",
    requestId,
    publisher: shared,
    repository: "example/project",
    branch: "feature/docs",
    headCommit: "a".repeat(40),
    url: "https://github.com/example/project/pull/1",
  };
  const nextRead = Promise.withResolvers<unknown>();
  const request = vi
    .fn()
    .mockResolvedValueOnce({
      ...options,
      latestShared: {
        result: published,
        confirmation: null,
      },
    })
    .mockReturnValueOnce(nextRead.promise);
  const { binding } = bind(request);
  const view = render(binding);
  await waitForSolid(() => expect(view.getByRole("link", { name: "Open PR" })).toBeTruthy());
  expect(binding.view()?.result).toEqual(published);
  expect(binding.view()?.onPublish).toBeUndefined();
  view.getByRole("button", { name: "Dismiss" }).click();
  await waitForSolid(() => {
    expect(view.queryByRole("link", { name: "Open PR" })).toBeNull();
    expect(view.container.querySelector<HTMLButtonElement>(".chat-pr__create")?.disabled).toBe(
      true,
    );
  });
  nextRead.resolve(options);
  await waitForSolid(() => expect(view.getByRole("button", { name: "Publish PR" })).toBeTruthy());
  expect(binding.view()?.result).toBeNull();
  expect(binding.view()?.onPublish).toBeTypeOf("function");
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "sessions.github.options",
    "sessions.github.options",
  ]);
  binding.detach();
});
