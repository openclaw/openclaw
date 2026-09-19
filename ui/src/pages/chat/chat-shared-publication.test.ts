/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import {
  options,
  requestId,
  setup,
  settled,
  shared,
} from "./chat-github-publication.test-support.ts";
import { renderGitHubPublicationAction } from "./components/chat-github-publication.ts";

const accepted = {
  requestId,
  publisher: shared,
  status: "requested" as const,
  message: "The shared publication was accepted.",
};
const published = {
  requestId,
  publisher: shared,
  status: "published" as const,
  url: "https://github.com/synthetic/publication-demo/pull/42",
  repository: "synthetic/publication-demo",
  branch: "feature/one",
  headCommit: "a".repeat(40),
};
const completed = { result: published, confirmation: null };

describe("shared publication observation", () => {
  it("restores a terminal shared receipt after reconnect and acknowledges it without a write", async () => {
    const { controller, request } = setup({ ...options, latestShared: completed });
    const restored = await settled(controller);
    expect(restored.result).toEqual(published);
    expect(restored.onPublish).toBeUndefined();
    restored.onNewAction?.();
    const fresh = await settled(controller);
    expect(fresh.result).toBeNull();
    expect(fresh.onPublish).toBeTypeOf("function");
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
    ).toHaveLength(0);
  });

  it("checks an accepted shared request by reading its receipt, never replaying publish", async () => {
    const { controller, request } = setup();
    await settled(controller);
    request.mockResolvedValueOnce(accepted);
    controller.view()?.onPublish?.();
    await settled(controller);
    request.mockImplementation(async (method: string) => {
      if (method === "sessions.github.status") {
        return completed;
      }
      if (method === "sessions.github.options") {
        return options;
      }
      throw new Error("An observation must not execute publication");
    });
    const container = document.createElement("div");
    try {
      render(renderGitHubPublicationAction(controller.view()!), container);
      container.querySelector<HTMLButtonElement>("button.chat-pr__create")!.click();
      expect((await settled(controller)).result).toEqual(published);
      expect(request).toHaveBeenLastCalledWith("sessions.github.status", {
        sessionKey: "agent:main:one",
        agentId: "main",
        requestId,
      });
      expect(
        request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
      ).toHaveLength(1);
    } finally {
      render(null, container);
    }
  });

  it("recovers an unknown shared outcome only through its exact invocation key", async () => {
    const { controller, request } = setup();
    await settled(controller);
    request.mockRejectedValueOnce(new Error("The acknowledgement was lost"));
    controller.view()?.onPublish?.();
    expect((await settled(controller)).locked).toBe(true);
    const key = request.mock.calls.at(-1)![1].idempotencyKey;
    request.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method !== "sessions.github.options") {
        throw new Error("Recovery must only read");
      }
      expect(params.idempotencyKey).toBe(key);
      return { ...options, latestShared: completed };
    });
    controller.view()?.onRefresh();
    expect((await settled(controller)).result).toEqual(published);
    expect(request).toHaveBeenLastCalledWith("sessions.github.options", {
      sessionKey: "agent:main:one",
      agentId: "main",
      idempotencyKey: key,
    });
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
    ).toHaveLength(1);
  });
});
