/* @vitest-environment jsdom */

import type { ClawsDraftsReviewResult } from "@openclaw/gateway-protocol";
import { fireEvent } from "@solidjs/testing-library";
import { createSignal, type Setter } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createContext } from "../skill-workshop/skill-workshop-page.test-support.ts";
import { clawCreatorFlow } from "./creator-flow.ts";
import { ClawCreatorReview } from "./creator-review.tsx";

const reviewed: ClawsDraftsReviewResult = {
  revision: "a".repeat(64),
  reviewToken: "b".repeat(64),
  publisher: "maker",
  name: "@maker/release-brief",
  displayName: "Release Brief",
  version: "0.1.0",
  description: "Summarizes releases",
  items: [],
  files: [{ path: "CLAW.md", content: "Portable instructions" }],
  scope: {
    input: "A public repository",
    job: "Summarize releases",
    output: "A release brief",
    authority: "Read public sources only",
  },
};

function createReviewContext(initial = reviewed) {
  const request = vi.fn(async (method: string) => {
    if (method === "claws.drafts.read") {
      return { revision: initial.revision, content: JSON.stringify({ scope: initial.scope }) };
    }
    if (method === "claws.drafts.review") {
      return initial;
    }
    throw new Error(`Unexpected method ${method}`);
  });
  const context = createContext(request);
  context.router.subscribe = () => () => true;
  const flow = clawCreatorFlow(context);
  flow.open("research", "ec8f46b0-4ca3-4991-8a73-dfdcc8764087");
  return { context, flow, request };
}

beforeEach(async () => {
  await i18n.setLocale("en");
  vi.useFakeTimers();
});

afterEach(() => {
  cleanupSolid();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("shows a held review without discarding the edited name or accepted package", async () => {
  const { context, request } = createReviewContext();
  const page = mountSolid(() => <ClawCreatorReview context={context} />);
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() =>
    expect(page.getByLabelText<HTMLInputElement>("Name").value).toBe("Release Brief"),
  );
  const pending = createDeferred<ClawsDraftsReviewResult>();
  request.mockImplementationOnce(() => pending.promise);
  fireEvent.input(page.getByLabelText("Name"), { target: { value: "Engineering Brief" } });
  await vi.advanceTimersByTimeAsync(350);
  await waitForSolid(() =>
    expect(page.getByRole("status").textContent).toContain("Updating package preview"),
  );
  expect(page.getByLabelText<HTMLInputElement>("Name").value).toBe("Engineering Brief");
  expect(page.getByRole<HTMLButtonElement>("button", { name: "Publish to ClawHub" }).disabled).toBe(
    true,
  );
  expect(page.queryByText("Portable instructions")).toBeNull();
  pending.resolve({ ...reviewed, displayName: "Engineering Brief" });
  await waitForSolid(() =>
    expect(
      page.getByRole<HTMLButtonElement>("button", { name: "Publish to ClawHub" }).disabled,
    ).toBe(false),
  );
  expect(page.getByLabelText<HTMLInputElement>("Name").value).toBe("Engineering Brief");
  expect(page.getByText("Portable instructions").isConnected).toBe(true);
});

it("keeps a rejected edit and shows loading again while its review retry is held", async () => {
  const { context, request } = createReviewContext();
  const page = mountSolid(() => <ClawCreatorReview context={context} />);
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() => expect(page.getByLabelText("Name").isConnected).toBe(true));
  request.mockRejectedValueOnce(new Error("Review unavailable. Try again."));
  fireEvent.input(page.getByLabelText("Name"), { target: { value: "Engineering Brief" } });
  await vi.advanceTimersByTimeAsync(350);
  await waitForSolid(() =>
    expect(page.getByRole("alert").textContent).toContain("Review unavailable"),
  );
  const pending = createDeferred<ClawsDraftsReviewResult>();
  request.mockImplementationOnce(() => pending.promise);
  fireEvent.click(page.getByRole("button", { name: "Refresh review" }));
  await waitForSolid(() =>
    expect(page.getByRole("status").textContent).toContain("Updating package preview"),
  );
  expect(page.getByLabelText<HTMLInputElement>("Name").value).toBe("Engineering Brief");
  pending.resolve({ ...reviewed, displayName: "Engineering Brief" });
  await waitForSolid(() => expect(page.queryByRole("alert")).toBeNull());
  expect(page.getByRole<HTMLButtonElement>("button", { name: "Publish to ClawHub" }).disabled).toBe(
    false,
  );
});

it("shows the replacement context while the old review is pending and ignores its late error", async () => {
  const first = createReviewContext();
  const second = createReviewContext({ ...reviewed, displayName: "Second Brief" });
  let selectContext!: Setter<ApplicationContext>;
  const page = mountSolid(() => {
    const [context, setContext] = createSignal(first.context);
    selectContext = setContext;
    return <ClawCreatorReview context={context()} />;
  });
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() =>
    expect(page.getByLabelText<HTMLInputElement>("Name").value).toBe("Release Brief"),
  );
  const pending = createDeferred<ClawsDraftsReviewResult>();
  first.request.mockImplementationOnce(() => pending.promise);
  fireEvent.input(page.getByLabelText("Name"), { target: { value: "Old edit" } });
  await vi.advanceTimersByTimeAsync(350);
  await waitForSolid(() =>
    expect(page.getByRole("status").textContent).toContain("Updating package preview"),
  );
  selectContext(second.context);
  await waitForSolid(() =>
    expect(page.getByLabelText<HTMLInputElement>("Name").value).toBe("Second Brief"),
  );
  pending.reject(new Error("Old review failed"));
  await waitForSolid(() => expect(page.queryByRole("alert")).toBeNull());
  expect(page.getByLabelText<HTMLInputElement>("Name").value).toBe("Second Brief");
  expect(page.getByRole<HTMLButtonElement>("button", { name: "Publish to ClawHub" }).disabled).toBe(
    false,
  );
});
