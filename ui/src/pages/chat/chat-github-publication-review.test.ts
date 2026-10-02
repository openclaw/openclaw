/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it } from "vitest";
import type { SessionGitHubReviewResult } from "../../../../packages/gateway-protocol/src/schema/session-github-publication.ts";
import {
  options,
  requestId,
  setup,
  settled,
  shared,
} from "./chat-github-publication.test-support.ts";
import {
  renderGitHubPublicationAction,
  renderGitHubPublicationDetails,
} from "./components/chat-github-publication.ts";
const candidate: SessionGitHubReviewResult = {
  reviewId: "bdca439a-e787-4f9f-b5f3-a878c662cc78",
  requestedReviewId: null,
  digest: "a".repeat(64),
  status: "ready",
  message: "Review this exact candidate.",
  diffLength: 7,
  target: {
    repository: "team/demo",
    pushRepository: "team/demo",
    branch: "feature/one",
    baseBranch: "main",
    baseCommit: "1".repeat(40),
    remoteHeadCommit: null,
    sourceHeadCommit: "2".repeat(40),
    sourceIndexTree: "3".repeat(40),
    workspaceTree: "4".repeat(40),
  },
  publisher: shared,
  title: "Reviewed change",
  body: "Description included in review.",
};
const reviewOptions = { ...options, reviewRequired: true, reviewAvailable: true, reviews: [] };
describe("same-conversation publication review", () => {
  it("shows a guest review request and never a publication callback", async () => {
    const { controller, request, scope } = setup(reviewOptions);
    controller.sync({
      ...scope,
      canRequestReview: true,
      canPublishShared: false,
      canPublishPersonal: false,
    });
    const view = await settled(controller);
    expect(view.onPublish).toBeUndefined();
    expect(view.onConfirmReview).toBeUndefined();
    const requested = {
      ...candidate,
      status: "requested",
      digest: null,
      target: undefined,
      publisher: undefined,
      title: undefined,
      body: undefined,
      diffLength: 0,
    };
    request.mockResolvedValueOnce(requested);
    view.onRequestReview?.();
    const done = await settled(controller);
    expect(request).toHaveBeenLastCalledWith(
      "sessions.github.requestReview",
      expect.objectContaining({
        sessionKey: scope.target.sessionKey,
        idempotencyKey: expect.any(String),
      }),
    );
    expect(done.review?.status).toBe("requested");
    expect(request.mock.calls.some(([method]) => method === "sessions.github.publish")).toBe(false);
  });
  it("requires complete exact diff pages before publishing the selected candidate", async () => {
    const { controller, request } = setup(reviewOptions);
    const view = await settled(controller);
    request
      .mockResolvedValueOnce(candidate)
      .mockResolvedValueOnce({
        reviewId: candidate.reviewId,
        digest: candidate.digest,
        offset: 0,
        nextOffset: 4,
        totalCharacters: 7,
        complete: false,
        text: "diff",
      })
      .mockResolvedValueOnce({
        reviewId: candidate.reviewId,
        digest: candidate.digest,
        offset: 4,
        nextOffset: null,
        totalCharacters: 7,
        complete: true,
        text: " ok",
      });
    view.onPublish?.();
    const ready = await settled(controller);
    expect(ready.reviewDiff).toBe("diff ok");
    expect(
      request.mock.calls.filter(([method]) => method === "sessions.github.publish"),
    ).toHaveLength(0);
    const container = document.createElement("div");
    render(renderGitHubPublicationDetails(ready), container);
    expect(container.textContent).toContain("Reviewed change");
    expect(container.textContent).toContain("Description included in review.");
    expect(container.textContent).toContain(candidate.digest);
    expect(container.querySelector("pre")?.textContent).toContain("Description");
    render(renderGitHubPublicationAction(ready), container);
    expect(container.textContent).toContain("Publish reviewed candidate");
    render(null, container);
    request.mockResolvedValueOnce({
      requestId,
      publisher: shared,
      status: "published",
      repository: "team/demo",
      branch: "feature/one",
      headCommit: "5".repeat(40),
      url: "https://github.com/team/demo/pull/1",
    });
    ready.onConfirmReview?.();
    await settled(controller);
    expect(request).toHaveBeenLastCalledWith(
      "sessions.github.publish",
      expect.objectContaining({
        idempotencyKey: `review:${candidate.reviewId}`,
        review: { reviewId: candidate.reviewId, digest: candidate.digest },
      }),
    );
  });
  it("does not allow confirmation of an incomplete or substituted diff", async () => {
    const { controller, request } = setup(reviewOptions);
    const view = await settled(controller);
    request.mockResolvedValueOnce(candidate).mockResolvedValueOnce({
      reviewId: candidate.reviewId,
      digest: "b".repeat(64),
      offset: 0,
      nextOffset: null,
      totalCharacters: 7,
      complete: true,
      text: "diff ok",
    });
    view.onPublish?.();
    const failed = await settled(controller);
    expect(failed.error).toContain("reviewed diff changed");
    expect(failed.onConfirmReview).toBeUndefined();
    expect(request.mock.calls.some(([method]) => method === "sessions.github.publish")).toBe(false);
  });
  it("keeps recovered review intent inert until the maintainer reads and confirms it", async () => {
    const { controller, request } = setup({
      ...reviewOptions,
      reviews: [{ ...candidate, status: "needs_confirmation" }],
    });
    const recovered = await settled(controller);
    expect(recovered.onConfirmReview).toBeUndefined();
    expect(request.mock.calls.map(([method]) => method)).toEqual(["sessions.github.options"]);
    expect(recovered.onReadReview).toBeTypeOf("function");
  });
});
