/* @vitest-environment jsdom */
import { createComponent, flush } from "solid-js";
import { expect, it } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  options,
  requestId,
  setup,
  settled,
  shared,
} from "./chat-github-publication.test-support.ts";
import { GitHubPublicationAction } from "./components/chat-github-publication.tsx";

const identity = { requestId, publisher: shared };
const accepted = { ...identity, status: "requested" as const, message: "Accepted" };
const published = {
  ...identity,
  status: "published" as const,
  url: "https://github.com/synthetic/publication-demo/pull/42",
  repository: "synthetic/publication-demo",
  branch: "feature/one",
  headCommit: "a".repeat(40),
};
const completed = { result: published, confirmation: null };
const publicationCalls = (request: ReturnType<typeof setup>["request"]) =>
  request.mock.calls.filter(([method]) => method === "sessions.github.publish");
const target = { sessionKey: "agent:main:one", agentId: "main" };

it("retires obsolete failures on discovery", async () => {
  const failure = {
    result: {
      ...identity,
      status: "failed",
      code: "unavailable",
      message: "GitHub publication failed.",
      nextAction: "Inspect the unpublished changes.",
    },
    confirmation: null,
  } as const;
  const { controller, request } = setup({ ...options, latestShared: failure });
  expect((await settled(controller)).result).toEqual(failure.result);
  request.mockResolvedValue(options);
  void controller.view()?.onRefresh();
  expect((await settled(controller)).result).toBeNull();
  void controller.view()?.onRefresh();
  expect((await settled(controller)).result).toBeNull();
  expect(request.mock.calls.every(([method]) => method === "sessions.github.options")).toBe(true);
});

it("checks receipts without replaying publication", async () => {
  const { controller, request } = setup();
  await settled(controller);
  request.mockResolvedValueOnce(accepted);
  void controller.view()?.onPublish?.();
  await settled(controller);
  request.mockImplementation(async (method: string) => {
    expect(["sessions.github.status", "sessions.github.options"]).toContain(method);
    return method === "sessions.github.status" ? completed : options;
  });
  const { container } = mountSolid(() =>
    createComponent(GitHubPublicationAction, { publication: controller.view()! }),
  );
  flush();
  container.querySelector<HTMLButtonElement>("button.chat-pr__create")!.click();
  expect((await settled(controller)).result).toEqual(published);
  expect(request).toHaveBeenLastCalledWith("sessions.github.status", { ...target, requestId });
  expect(publicationCalls(request)).toHaveLength(1);
});

it("recovers unknown outcomes by exact invocation key", async () => {
  const { controller, request } = setup();
  await settled(controller);
  request.mockRejectedValueOnce(new Error("The acknowledgement was lost"));
  void controller.view()?.onPublish?.();
  expect(await settled(controller)).toMatchObject({ locked: true, optionsUnavailable: false });
  const key = request.mock.calls.at(-1)![1].idempotencyKey;
  const invocation = { ...target, idempotencyKey: key };
  request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    expect(method).toBe("sessions.github.options");
    expect(params.idempotencyKey).toBe(key);
    return { ...options, latestShared: completed };
  });
  void controller.view()?.onRefresh();
  expect((await settled(controller)).result).toEqual(published);
  expect(request).toHaveBeenLastCalledWith("sessions.github.options", invocation);
  expect(publicationCalls(request)).toHaveLength(1);
});
