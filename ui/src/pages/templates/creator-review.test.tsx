/* @vitest-environment jsdom */
import type { TemplatesDraftsReviewResult } from "@openclaw/gateway-protocol";
import { fireEvent } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
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
import { TemplateCreatorInlineReview } from "./creator-inline-review.tsx";
import { TemplateCreatorReview } from "./creator-review.tsx";

const skillContent = "Read the release history and cite the source for each finding.";
const pluginContent = "Connect to GitHub issues, pull requests, and checks.";
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
      id: "skill:release",
      kind: "skill",
      requirement: { source: "clawhub", ref: "@maker/release-notes", version: "1.2.3" },
      label: "Release notes",
      detail: "Read releases",
      included: true,
    },
    {
      id: "plugin:github",
      kind: "plugin",
      requirement: { source: "clawhub", ref: "@maker/github", version: "2.0.0" },
      label: "GitHub",
      detail: "github@1.0.0",
      included: true,
    },
    {
      id: "mcp:docs",
      kind: "mcp",
      label: "Docs",
      detail: JSON.stringify({
        transport: "streamable-http",
        url: "https://example.test/mcp",
        auth: "oauth",
      }),
      included: true,
    },
    {
      id: "automation:brief",
      kind: "automation",
      automation: {
        message:
          "Read the latest repository releases, cite their sources, and prepare a concise morning brief. Never publish without human review.",
        schedule: { cron: "0 9 * * 1-5", timezone: "America/Los_Angeles" },
        session: "isolated",
        enabled: true,
      },
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
const pendingPublication = {
  name: reviewed.name,
  version: reviewed.version,
  url: "https://example.test/maker/templates/release-brief",
  publicationStatus: "pending",
};
const target = {
  agentId: "research",
  draftId: "ec8f46b0-4ca3-4991-8a73-dfdcc8764087",
  sessionKey: "agent:research:main",
};
async function fixture(review = reviewed) {
  const request = vi.fn(
    async (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
      if (method === "plugins.catalog.get") {
        return {
          plugin: { catalog: { summary: pluginContent } },
          detail: {
            origin: "clawhub",
            packageName: "@maker/github",
            selectedRelease: { version: "2.0.0" },
          },
        };
      }
      if (method === "skills.detail") {
        return {
          card: {
            status: "available",
            content: `# Release notes\n${skillContent}`,
          },
        };
      }
      if (method === "templates.drafts.read") {
        return { revision: reviewed.revision, content: JSON.stringify({ scope: reviewed.scope }) };
      }
      if (method === "templates.drafts.review") {
        return review;
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
  context.router.subscribe = () => () => false;
  const flow = templateCreatorFlow(context);
  flow.open(target.agentId, target.draftId);
  const page = mountSolid(() => <TemplateCreatorReview context={context} />);
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() =>
    expect(page.getByRole("heading", { name: reviewed.displayName })).toBeTruthy(),
  );
  return { page, request, flow, context };
}
beforeEach(async () => {
  await i18n.setLocale("en");
  vi.useFakeTimers();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(["skill", "plugin"] as const)("previews pinned and bundled %s", async (kind) => {
  for (const bundled of [false, true]) {
    const review = structuredClone(reviewed);
    const item = review.items.find((entry) => entry.kind === kind)!;
    const content = bundled
      ? "Bundled with template"
      : kind === "skill"
        ? skillContent
        : pluginContent;
    if (bundled) {
      item.requirement = { source: "bundled", path: "bundled" };
      review.files.push({ path: "bundled/SKILL.md", content });
    }
    const { page, request } = await fixture(review);
    fireEvent.click(
      page.getByRole("button", { name: new RegExp(kind === "skill" ? "Skills" : "Plugins") }),
    );
    await waitForSolid(() => expect(page.getByRole("button", { name: item.label })).toBeTruthy());
    fireEvent.click(page.getByRole("button", { name: item.label }));
    await waitForSolid(() => expect(page.getByText(content, { exact: true })).toBeTruthy());
    const previews = request.mock.calls.filter(([method]) =>
      ["skills.detail", "plugins.catalog.get"].includes(method),
    );
    const pinned =
      kind === "skill"
        ? ["skills.detail", { slug: "@maker/release-notes", version: "1.2.3" }]
        : ["plugins.catalog.get", { id: "ch_QG1ha2VyL2dpdGh1Yg", version: "2.0.0" }];
    expect(previews).toEqual(bundled ? [] : [pinned]);
    page.unmount();
  }
});

it("keeps the original card through a single explicit publication and pending receipt", async () => {
  const { page, request } = await fixture();
  const pending = createDeferred<unknown>();
  request.mockImplementation(async (method: string) =>
    method === "templates.drafts.publish" ? pending.promise : reviewed,
  );
  const status = () =>
    page.container.querySelector(".template-creator__header [role=status]")?.textContent;
  expect(status()).toBe("Unpublished");
  const card = page.container.querySelector(".template-creator");
  const publish = page.getByRole("button", { name: "Publish" });
  fireEvent.click(publish);
  fireEvent.click(publish);
  await waitForSolid(() => expect(page.getByText("Publishing…")).toBeTruthy());
  expect(request.mock.calls.filter(([m]) => m === "templates.drafts.publish")).toHaveLength(1);
  pending.resolve(pendingPublication);
  await waitForSolid(() => expect(page.getByText("Pending", { exact: true })).toBeTruthy());
  expect(page.container.querySelector(".template-creator")).toBe(card);
  expect(page.queryByText("Published")).toBeNull();
  expect(page.getByRole("link", { name: "View submission" }).classList.contains("primary")).toBe(
    true,
  );
  expect(status()).toBe("Pending");
});

it.each(["none", "unconfirmed", "transport"])(
  "keeps %s failure honest and never silently resubmits",
  async (effect) => {
    const { page, request } = await fixture();
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
      expect(page.queryByRole("button", { name: /^Retry$/ })).toBeNull();
      fireEvent.click(page.getByRole("button", { name: /^Check status$/ }));
      await waitForSolid(() =>
        expect(
          request.mock.calls.some(
            ([m, p]) => m === "templates.drafts.review" && p?.checkPublication,
          ),
        ).toBe(true),
      );
    } else {
      fireEvent.click(page.getByRole("button", { name: /^Retry$/ }));
      await waitForSolid(() => expect(page.getByRole("button", { name: "Publish" })).toBeTruthy());
    }
    expect(request.mock.calls.filter(([m]) => m === "templates.drafts.publish")).toHaveLength(1);
  },
);

it("retains pending receipt across remount and promotes only a matching registry confirmation", async () => {
  const { page, request, flow, context } = await fixture();
  const publication = { ...pendingPublication, attemptId: "attempt-1" };
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
  page.unmount();
  flow.retirePresentation();
  const remounted = mountSolid(() => (
    <TemplateCreatorInlineReview
      context={context}
      payload={target}
      sessionKey={target.sessionKey}
      agentId={target.agentId}
    />
  ));
  await waitForSolid(() => expect(remounted.getByText("Published", { exact: true })).toBeTruthy());
  expect(remounted.getByRole("button", { name: "Copy link" }).textContent).toBe("Copy link");
  expect(remounted.queryByRole("link", { name: "View on ClawHub" })).toBeNull();
  expect(request.mock.calls.findLast(([m]) => m === "templates.drafts.review")?.[1]).toMatchObject({
    checkPublication: true,
    attemptId: "attempt-1",
    reviewToken: reviewed.reviewToken,
  });
  expect(request.mock.calls.filter(([m]) => m === "templates.drafts.publish")).toHaveLength(1);
});

it("will not publish when review is stale or operator authority is revoked", async () => {
  const { request, flow } = await fixture();
  flow.reviewCurrent = false;
  await flow.publish();
  expect(request.mock.calls.some(([m]) => m === "templates.drafts.publish")).toBe(false);
});

it("shares the draft through sidebar handoff and remounts revised metadata before publication", async () => {
  const { page, flow, context, request } = await fixture();
  expect(templateCreatorFlow(context, target)).toBe(flow);
  const renderInline = () => (
    <TemplateCreatorInlineReview
      context={context}
      payload={target}
      sessionKey={target.sessionKey}
      agentId={target.agentId}
    />
  );
  const inline = mountSolid(renderInline);
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() => expect(inline.getByRole("button", { name: "Publish" })).toBeTruthy());
  expect(page.queryByRole("region")).toBeNull();
  expect(templateCreatorFlow(context)).not.toBe(flow);
  expect(templateCreatorFlow(context, target)).toBe(flow);
  expect(request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(0);
  inline.unmount();
  const updated = {
    ...reviewed,
    revision: "c".repeat(64),
    reviewToken: "d".repeat(64),
    name: "@maker/revised-brief",
    displayName: "Revised Brief",
    description: "Latest release research",
  };
  request.mockImplementation(async (method) =>
    method === "templates.drafts.read"
      ? { revision: updated.revision, content: JSON.stringify({ scope: updated.scope }) }
      : method === "templates.drafts.review"
        ? updated
        : pendingPublication,
  );
  const remounted = mountSolid(renderInline);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    request.mock.calls.findLast(([method]) => method === "templates.drafts.review")?.[1],
  ).toEqual({ agentId: target.agentId, draftId: target.draftId });
  await waitForSolid(() =>
    expect(remounted.getByRole("heading", { name: "Revised Brief" })).toBeTruthy(),
  );
  fireEvent.click(remounted.getByRole("button", { name: "Publish" }));
  await waitForSolid(() => expect(flow.publication?.publicationStatus).toBe("pending"));
  expect(request.mock.lastCall).toEqual([
    "templates.drafts.publish",
    expect.objectContaining({
      reviewToken: updated.reviewToken,
      choices: {
        name: "revised-brief",
        displayName: updated.displayName,
        description: updated.description,
        excluded: [],
      },
    }),
  ]);
});

it("observes the mutable session before deciding whether to show the review", async () => {
  const { page, flow, context } = await fixture();
  page.unmount();
  const targetSession = "agent:research:dashboard:destination";
  const destination = mountSolid(() => (
    <TemplateCreatorReview context={context} sessionKey={targetSession} />
  ));
  await vi.advanceTimersByTimeAsync(0);
  expect(destination.queryByRole("region")).toBeNull();
  flow.open("research", "next-draft", targetSession);
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() =>
    expect(destination.getByRole("button", { name: "Publish" })).toBeTruthy(),
  );
  flow.open("research", "other-draft", "agent:research:main");
  await waitForSolid(() => expect(destination.queryByRole("region")).toBeNull());
});

it("releases a removed review during publication while its owner records the eventual result", async () => {
  const { page, flow, context, request } = await fixture();
  page.unmount();
  const [shown, setShown] = createSignal(true);
  const presentation = mountSolid(() => (
    <Show when={shown()}>
      <TemplateCreatorReview context={context} />
    </Show>
  ));
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() =>
    expect(presentation.getByRole("button", { name: "Publish" })).toBeTruthy(),
  );
  const pending = createDeferred<unknown>();
  request.mockImplementation(async (method) =>
    method === "templates.drafts.publish" ? pending.promise : reviewed,
  );
  fireEvent.click(presentation.getByRole("button", { name: "Publish" }));
  await waitForSolid(() => expect(presentation.getByText("Publishing…")).toBeTruthy());
  try {
    setShown(false);
    await waitForSolid(() => expect(presentation.queryByRole("region")).toBeNull());
    expect(flow.busy).toBe("publishing");
  } finally {
    pending.resolve(pendingPublication);
  }
  await waitForSolid(() => expect(flow.publication?.publicationStatus).toBe("pending"));
  expect(request.mock.calls.filter(([m]) => m === "templates.drafts.publish")).toHaveLength(1);
});
