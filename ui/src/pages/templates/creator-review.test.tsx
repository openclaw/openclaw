/* @vitest-environment jsdom */
import type { TemplatesDraftsReviewResult } from "@openclaw/gateway-protocol";
import { fireEvent } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import {
  createContext,
  createRuntimeConfigStub,
} from "../skill-workshop/skill-workshop-page.test-support.ts";
import { templateCreatorFlow } from "./creator-flow.ts";
import { TemplateCreatorReview } from "./creator-review.tsx";

const reviewed: TemplatesDraftsReviewResult = {
  revision: "a".repeat(64),
  reviewToken: "b".repeat(64),
  publisher: "maker",
  name: "@maker/release-brief",
  displayName: "Release Brief",
  version: "0.1.0",
  description: "Summarizes releases",
  scope: { input: "Repository", job: "Summarize", output: "Brief", authority: "Read only" },
  items: [
    {
      id: "file:AGENTS.md",
      kind: "file",
      label: "AGENTS.md",
      detail: "Read only instructions",
      included: true,
    },
    {
      id: "skill:release",
      kind: "skill",
      label: "Release notes",
      detail: "Read releases",
      included: true,
    },
    {
      id: "plugin:github",
      kind: "plugin",
      label: "GitHub",
      detail: "github@1.0.0",
      included: true,
    },
    {
      id: "mcp:docs",
      kind: "mcp",
      label: "Docs",
      detail: "https://example.test/mcp",
      included: true,
    },
    {
      id: "automation:brief",
      kind: "automation",
      label: "Morning brief",
      detail: "0 9 * * *",
      included: true,
    },
  ],
  files: [
    { path: "CLAW.md", content: "Portable behavior" },
    { path: "AGENTS.md", content: "Read only instructions" },
  ],
};
function fixture() {
  const request = vi.fn(
    async (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
      if (method === "templates.drafts.read") {
        return { revision: reviewed.revision, content: JSON.stringify({ scope: reviewed.scope }) };
      }
      if (method === "templates.drafts.review") {
        return reviewed;
      }
      throw new Error("Unexpected " + method);
    },
  );
  const context = createContext(request, {
    methods: ["templates.drafts.create", "chat.send"],
    runtimeConfig: createRuntimeConfigStub({
      sourceConfig: { gateway: { controlUi: { experimental: { templates: true } } } },
    }),
  });
  context.router.subscribe = () => () => {};
  const flow = templateCreatorFlow(context);
  flow.open("research", "ec8f46b0-4ca3-4991-8a73-dfdcc8764087");
  const page = mountSolid(() => <TemplateCreatorReview context={context} />);
  return { page, request, flow };
}
beforeEach(async () => {
  await i18n.setLocale("en");
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("reviews the exact assembled package inline without editable fields or model turns", async () => {
  const { page, request } = fixture();
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() =>
    expect(page.getByRole("heading", { name: "Release Brief" })).toBeTruthy(),
  );
  expect(page.queryByRole("dialog")).toBeNull();
  expect(page.container.querySelector("input, textarea")).toBeNull();
  expect(page.getByText("by @maker")).toBeTruthy();
  for (const label of ["Workspace files", "Skills", "Plugins", "MCP servers", "Automations"]) {
    fireEvent.click(page.getByRole("button", { name: new RegExp(label) }));
    await waitForSolid(() =>
      expect(page.getByRole("button", { name: "Back to Template" })).toBeTruthy(),
    );
    expect(page.container.querySelector("input, textarea")).toBeNull();
    fireEvent.click(page.getByRole("button", { name: "Back to Template" }));
    await waitForSolid(() =>
      expect(page.getByRole("heading", { name: "Release Brief" })).toBeTruthy(),
    );
  }
  expect(request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  expect(request.mock.calls.some(([method]) => method === "templates.drafts.publish")).toBe(false);
});

it("keeps the original card through a single explicit publication and pending receipt", async () => {
  const { page, request } = fixture();
  await vi.advanceTimersByTimeAsync(0);
  const pending = createDeferred<unknown>();
  request.mockImplementation(async (method: string) =>
    method === "templates.drafts.publish" ? pending.promise : reviewed,
  );
  await waitForSolid(() => expect(page.getByRole("button", { name: "Publish" })).toBeTruthy());
  const card = page.container.querySelector(".template-creator");
  const publish = page.getByRole("button", { name: "Publish" });
  fireEvent.click(publish);
  fireEvent.click(publish);
  await waitForSolid(() => expect(page.getByText("Publishing…")).toBeTruthy());
  expect(request.mock.calls.filter(([m]) => m === "templates.drafts.publish")).toHaveLength(1);
  pending.resolve({
    name: reviewed.name,
    version: reviewed.version,
    url: "https://example.test/maker/templates/release-brief",
    publicationStatus: "pending",
  });
  await waitForSolid(() => expect(page.getByText("Pending security scans")).toBeTruthy());
  expect(page.container.querySelector(".template-creator")).toBe(card);
  expect(page.queryByText("Published")).toBeNull();
  expect(page.getByRole("link", { name: "View submission" })).toBeTruthy();
});

it.each(["none", "unconfirmed", "transport"])(
  "keeps %s failure honest and never silently resubmits",
  async (effect) => {
    const { page, request } = fixture();
    await vi.advanceTimersByTimeAsync(0);
    await waitForSolid(() => expect(page.getByRole("button", { name: "Publish" })).toBeTruthy());
    const card = page.container.querySelector(".template-creator");
    request.mockImplementation(async (method: string) => {
      if (method === "templates.drafts.publish") {
        throw effect === "transport"
          ? new Error("offline")
          : new GatewayRequestError({
              code: "UNAVAILABLE",
              message: "Not accepted",
              details: { templatePublication: { effect } },
            });
      }
      return { ...reviewed, publicationState: { status: "unconfirmed" } };
    });
    fireEvent.click(page.getByRole("button", { name: "Publish" }));
    await waitForSolid(() =>
      expect(
        page.getByText(effect === "none" ? "Not published" : "Submission unconfirmed"),
      ).toBeTruthy(),
    );
    expect(page.container.querySelector(".template-creator")).toBe(card);
    expect(page.queryByText("Published")).toBeNull();
    if (effect !== "none") {
      expect(page.queryByRole("button", { name: "Retry", exact: true })).toBeNull();
      fireEvent.click(page.getByRole("button", { name: "Check status", exact: true }));
      await waitForSolid(() =>
        expect(
          request.mock.calls.some(
            ([m, p]) => m === "templates.drafts.review" && p?.checkPublication,
          ),
        ).toBe(true),
      );
    } else {
      fireEvent.click(page.getByRole("button", { name: "Retry", exact: true }));
      await waitForSolid(() => expect(page.getByRole("button", { name: "Publish" })).toBeTruthy());
    }
    expect(request.mock.calls.filter(([m]) => m === "templates.drafts.publish")).toHaveLength(1);
  },
);

it("retains pending receipt across remount and promotes only a matching registry confirmation", async () => {
  const { page, request, flow } = fixture();
  await vi.advanceTimersByTimeAsync(0);
  const publication = {
    name: reviewed.name,
    version: reviewed.version,
    url: "https://example.test/template",
    publicationStatus: "pending",
    attemptId: "attempt-1",
  };
  request.mockImplementation(async (method: string) =>
    method === "templates.drafts.publish"
      ? publication
      : {
          ...reviewed,
          publicationState: {
            status: "published",
            publication: { ...publication, publicationStatus: "published" },
          },
        },
  );
  await flow.publish();
  flow.retirePresentation();
  flow.hydrate("research", "ec8f46b0-4ca3-4991-8a73-dfdcc8764087", flow.sessionKey!);
  await waitForSolid(() => expect(page.getByText("Published", { exact: true })).toBeTruthy());
  expect(request.mock.calls.findLast(([m]) => m === "templates.drafts.review")?.[1]).toMatchObject({
    checkPublication: true,
    attemptId: "attempt-1",
    reviewToken: reviewed.reviewToken,
  });
  expect(request.mock.calls.filter(([m]) => m === "templates.drafts.publish")).toHaveLength(1);
});

it("will not publish when review is stale or operator authority is revoked", async () => {
  const { request, flow } = fixture();
  await vi.advanceTimersByTimeAsync(0);
  flow.reviewCurrent = false;
  await flow.publish();
  expect(request.mock.calls.some(([m]) => m === "templates.drafts.publish")).toBe(false);
});
