/* @vitest-environment jsdom */

import type { ClawsDraftsReviewResult } from "@openclaw/gateway-protocol";
import { fireEvent } from "@solidjs/testing-library";
import { createSignal, type Setter } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
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
  scope: { input: "Repository", job: "Summarize", output: "Brief", authority: "Read only" },
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
  clawCreatorFlow(context).open("research", "ec8f46b0-4ca3-4991-8a73-dfdcc8764087");
  return { context, request };
}

async function mountReview(initialContext: ApplicationContext) {
  let selectContext!: Setter<ApplicationContext>;
  const page = mountSolid(() => {
    const [context, setContext] = createSignal(initialContext);
    selectContext = setContext;
    return <ClawCreatorReview context={context()} />;
  });
  const name = () => page.getByLabelText<HTMLInputElement>("Name");
  const publish = () => page.getByRole<HTMLButtonElement>("button", { name: "Publish to ClawHub" });
  const status = () => page.getByRole("status").textContent;
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() => expect(name().value).toBe("Release Brief"));
  return {
    ...page,
    name,
    publish,
    selectContext,
    edit: async (value: string) => {
      fireEvent.input(name(), { target: { value } });
      await vi.advanceTimersByTimeAsync(350);
    },
    updating: () => waitForSolid(() => expect(status()).toContain("Updating package preview")),
  };
}

beforeEach(async () => {
  await i18n.setLocale("en");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each([false, true])("holds review edits (retry=%s)", async (retry) => {
  const { context, request } = createReviewContext();
  const page = await mountReview(context);
  if (retry) {
    request.mockRejectedValueOnce(new Error("Review unavailable. Try again."));
    await page.edit("Engineering Brief");
    await waitForSolid(() =>
      expect(page.getByRole("alert").textContent).toContain("Review unavailable"),
    );
  }
  const pending = createDeferred<ClawsDraftsReviewResult>();
  request.mockImplementationOnce(() => pending.promise);
  if (retry) {
    fireEvent.click(page.getByRole("button", { name: "Refresh review" }));
  } else {
    await page.edit("Engineering Brief");
  }
  await page.updating();
  expect(page.name().value).toBe("Engineering Brief");
  expect(page.publish().disabled).toBe(true);
  expect(page.queryByText("Portable instructions")).toBeNull();
  pending.resolve({ ...reviewed, displayName: "Engineering Brief" });
  await waitForSolid(() => expect(page.publish().disabled).toBe(false));
  expect(page.name().value).toBe("Engineering Brief");
  expect(page.getByText("Portable instructions").isConnected).toBe(true);
  expect(page.queryByRole("alert")).toBeNull();
});

it("shows the replacement context while the old review is pending and ignores its late error", async () => {
  const first = createReviewContext();
  const second = createReviewContext({ ...reviewed, displayName: "Second Brief" });
  const page = await mountReview(first.context);
  const pending = createDeferred<ClawsDraftsReviewResult>();
  first.request.mockImplementationOnce(() => pending.promise);
  await page.edit("Old edit");
  await page.updating();
  page.selectContext(second.context);
  await waitForSolid(() => expect(page.name().value).toBe("Second Brief"));
  pending.reject(new Error("Old review failed"));
  await waitForSolid(() => expect(page.queryByRole("alert")).toBeNull());
  expect(page.name().value).toBe("Second Brief");
  expect(page.publish().disabled).toBe(false);
});
