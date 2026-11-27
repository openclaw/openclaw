/* @vitest-environment jsdom */
import { fireEvent, within } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { GatewayRequestError } from "../../api/gateway.ts";
import { reviewed } from "../../e2e/template-chat-review.test-support.ts";
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
const pendingPublication = {
  name: reviewed.name,
  version: reviewed.version,
  url: "https://example.test/maker/templates/research-brief",
  publicationStatus: "pending",
};
const target = {
  agentId: "research",
  draftId: "ec8f46b0-4ca3-4991-8a73-dfdcc8764087",
  sessionKey: "agent:research:main",
};
function mountInline(context: ReturnType<typeof createContext>) {
  return mountSolid(() => (
    <TemplateCreatorInlineReview context={context} payload={target} {...target} />
  ));
}
function creatorContext(request: ReturnType<typeof vi.fn>, signIn = false) {
  return createContext(request, {
    methods: [
      "templates.drafts.create",
      "chat.send",
      ...(signIn ? ["templates.drafts.signIn"] : []),
    ],
    scopes: ["operator.admin"],
    runtimeConfig: createRuntimeConfigStub({
      sourceConfig: { gateway: { controlUi: { experimental: { templates: true } } } },
    }),
  });
}
function setup(review = reviewed) {
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
  const context = creatorContext(request);
  context.router.subscribe = () => () => false;
  return { request, context };
}
async function fixture(review = reviewed) {
  const { request, context } = setup(review);
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(["copied", "denied", "blocked"])(
  "hands the code to ClawHub (%s), then resumes the same draft",
  async (outcome) => {
    const verificationUrl = "https://clawhub.example/cli/device";
    const userCode = "ZYXW-2345";
    const { agentId, draftId, sessionKey: sourceSessionKey } = target;
    const started = createDeferred();
    let approved = false;
    const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "templates.drafts.signIn") {
        expect(params).toMatchObject({ agentId, draftId, sourceSessionKey });
        switch (params.action) {
          case "status":
            return { status: "required" };
          case "start":
            await started.promise;
            return {
              status: "pending",
              requestId: "one",
              verificationUrl,
              userCode,
              pollAfterMs: 20,
              expiresAt: Date.now() + 60000,
            };
          case "poll":
            expect(params.requestId).toBe("one");
            approved = true;
            return { status: "connected" };
        }
      }
      if (method === "templates.drafts.read") {
        return {
          revision: approved ? "ready" : "drafting",
          content: JSON.stringify({ scope: approved ? reviewed.scope : {} }),
        };
      }
      if (method === "templates.drafts.review") {
        expect(approved).toBe(true);
        expect(params).toEqual({ agentId, draftId });
        return reviewed;
      }
      throw new Error("Unexpected " + method);
    });
    const page = mountInline(creatorContext(call, true));
    const write = createDeferred();
    const writeText = vi.fn(() => write.promise);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const replace = vi.fn();
    const close = vi.fn();
    const tab = { location: { replace }, close } as unknown as Window;
    const open = vi.spyOn(window, "open").mockReturnValue(outcome === "blocked" ? null : tab);
    await vi.advanceTimersByTimeAsync(1);
    expect(page.getByRole("status").textContent).toBe("Sign in to ClawHub");
    const button = page.getByRole("button", { name: "Sign in" });
    expect(page.getAllByRole("button")).toEqual([button]);
    fireEvent.click(button);
    fireEvent.click(button);
    await vi.advanceTimersByTimeAsync(1);
    expect(page.getByRole("button", { name: "Sign in", busy: true })).toBe(button);
    expect(page.getByRole("status").textContent).toBe("Sign in to ClawHub");
    started.resolve();
    await vi.advanceTimersByTimeAsync(1);
    expect(call.mock.calls.filter(([, p]) => p.action === "start")).toHaveLength(1);
    expect(page.getByRole("status").textContent).toBe(userCode);
    expect(open).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(page.getAllByRole("button")).toEqual([
      page.getByRole("button", { name: "Copy & open ClawHub" }),
    ]);
    expect(page.queryByRole("link")).toBeNull();
    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledWith(userCode);
    expect(writeText).toHaveBeenCalledBefore(open);
    expect(open).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    if (outcome === "denied") {
      write.reject(new Error("Permission denied"));
    } else {
      write.resolve();
    }
    await vi.advanceTimersByTimeAsync(0);
    if (outcome === "copied") {
      expect(replace).toHaveBeenCalledWith(verificationUrl);
      expect(page.queryByRole("alert")).toBeNull();
    } else {
      expect(replace).not.toHaveBeenCalled();
      expect(page.getByRole("alert").textContent).toContain(
        outcome === "denied" ? "Copy the code manually" : "Code copied",
      );
      expect(page.getByRole("link", { name: "Open ClawHub" }).getAttribute("href")).toBe(
        verificationUrl,
      );
      if (outcome === "denied") {
        expect(close).toHaveBeenCalledOnce();
      }
    }
    await vi.advanceTimersByTimeAsync(30);
    expect(page.getByRole("button", { name: "Publish" })).toBeTruthy();
    const card = page.getByRole("region", { name: "Publish Template" });
    expect(within(card).getByRole("status").textContent).toBe("Unpublished");
    fireEvent.click(within(card).getByRole("button", { name: "Preview" }));
    const preview = within(await page.findByRole("dialog", { name: "Preview Template" }));
    expect(preview.getByRole("heading", { name: reviewed.displayName })).toBeTruthy();
    fireEvent.click(preview.getByRole("button", { name: "Close" }));
    await waitForSolid(() => expect(page.queryByRole("dialog")).toBeNull());
    expect(page.getByRole("region", { name: "Publish Template" })).toBe(card);
    const methods = call.mock.calls.map(([method]) => method);
    expect(methods.filter((m) => m === "templates.drafts.review")).toHaveLength(1);
    expect(methods).not.toContain("chat.send");
    expect(methods).not.toContain("templates.drafts.publish");
  },
);

it("offers retry without presenting a review card for a failed initial preparation", async () => {
  const { request, context } = setup();
  request
    .mockResolvedValueOnce({
      revision: reviewed.revision,
      content: JSON.stringify({ scope: reviewed.scope }),
    })
    .mockRejectedValueOnce(new Error("Draft review failed"));
  const page = mountSolid(() => (
    <TemplateCreatorInlineReview
      context={context}
      payload={target}
      sessionKey={target.sessionKey}
    />
  ));
  await vi.advanceTimersByTimeAsync(0);
  await waitForSolid(() =>
    expect(page.getByRole("alert").textContent).toContain("Draft review failed"),
  );
  expect(page.queryByRole("region", { name: "Publish Template" })).toBeNull();
  const retry = createDeferred<typeof reviewed>();
  request.mockReturnValueOnce(retry.promise);
  fireEvent.click(page.getByRole("button", { name: "Try again" }));
  await waitForSolid(() => expect(page.container.textContent).toBe(""));
  retry.resolve(reviewed);
  await waitForSolid(() => expect(page.getByRole("button", { name: "Publish" })).toBeTruthy());
  expect(page.getAllByRole("region", { name: "Publish Template" })).toHaveLength(1);
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
    fireEvent.click(page.getByRole("button", { name: "Preview" }));
    await waitForSolid(() =>
      expect(page.getByRole("dialog", { name: "Preview Template" })).toBeTruthy(),
    );
    const preview = within(page.getByRole("dialog", { name: "Preview Template" }));
    fireEvent.click(
      preview.getByRole("button", { name: new RegExp(kind === "skill" ? "Skills" : "Plugins") }),
    );
    await waitForSolid(() =>
      expect(preview.getByRole("button", { name: item.label })).toBeTruthy(),
    );
    fireEvent.click(preview.getByRole("button", { name: item.label }));
    await waitForSolid(() => expect(preview.getByText(content, { exact: true })).toBeTruthy());
    const previews = request.mock.calls.filter(([method]) =>
      ["skills.detail", "plugins.catalog.get"].includes(method),
    );
    const pinned =
      kind === "skill"
        ? ["skills.detail", { slug: "@maker/release-notes", version: "1.2.3" }]
        : ["plugins.catalog.get", { id: "ch_QG1ha2VyL2dpdGh1Yg", version: "2.0.0" }];
    expect(previews).toEqual(bundled ? [] : [pinned]);
    fireEvent.click(preview.getByRole("button", { name: "Close" }));
    await waitForSolid(() => expect(page.queryByRole("dialog")).toBeNull());
    expect(request.mock.calls.some(([m]) => m === "templates.drafts.publish")).toBe(false);
    page.unmount();
  }
});

it("shows the packaged avatar and lists its binary file without a text preview", async () => {
  const plain = await fixture();
  expect(plain.page.container.querySelector(".template-publish-card header svg")).toBeTruthy();
  expect(plain.page.container.querySelector(".template-publish-card header img")).toBeNull();
  plain.page.unmount();

  const iconUrl = "data:image/png;base64,iVBORw0KGgo=";
  const { page } = await fixture({
    ...reviewed,
    iconUrl,
    files: [...reviewed.files, { path: "assets/icon.png", workspacePaths: ["avatars/avatar.png"] }],
  });
  expect(
    page.container.querySelector(".template-publish-card header img")?.getAttribute("src"),
  ).toBe(iconUrl);
  fireEvent.click(page.getByRole("button", { name: "Preview" }));
  const dialog = await page.findByRole("dialog", { name: "Preview Template" });
  expect(dialog.querySelector("header img")?.getAttribute("src")).toBe(iconUrl);
  fireEvent.click(within(dialog).getByRole("button", { name: /Workspace files/ }));
  await waitForSolid(() => expect(page.getByRole("button", { name: "View all" })).toBeTruthy());
  fireEvent.click(page.getByRole("button", { name: "View all" }));
  await waitForSolid(() =>
    expect(page.getByRole("button", { name: "assets/icon.png" })).toBeTruthy(),
  );
  fireEvent.click(page.getByRole("button", { name: "assets/icon.png" }));
  await waitForSolid(() =>
    expect(page.getByText("Package preview is unavailable for this version.")).toBeTruthy(),
  );
});

it("keeps the original card through a single explicit publication and pending receipt", async () => {
  const { page, request, flow } = await fixture();
  expect(page.getAllByRole("button").map((button) => button.textContent)).toEqual([
    "Preview",
    "Publish",
  ]);
  expect(page.queryByText("Workspace files")).toBeNull();
  expect(page.getByText("by @maker")).toBeTruthy();
  expect(page.getByText(reviewed.description)).toBeTruthy();
  const pending = createDeferred<unknown>();
  request.mockImplementation(async (method: string) =>
    method === "templates.drafts.publish" ? pending.promise : reviewed,
  );
  const status = () => page.container.querySelector("header [role=status]")?.textContent;
  expect(status()).toBe("Unpublished");
  const card = page.getByRole("region", { name: "Publish Template" });
  const publish = page.getByRole("button", { name: "Publish" });
  fireEvent.click(publish);
  fireEvent.click(publish);
  await waitForSolid(() =>
    expect(page.getByRole("button", { name: "Publishing", busy: true }).matches(":disabled")).toBe(
      true,
    ),
  );
  expect(page.queryByRole("button", { name: "Preview" })).toBeNull();
  expect(
    page.getByRole("button", { name: "Publishing" }).querySelector(".btn__spinner"),
  ).toBeTruthy();
  expect(request.mock.calls.filter(([m]) => m === "templates.drafts.publish")).toHaveLength(1);
  pending.resolve(pendingPublication);
  await waitForSolid(() => expect(page.getByText("Pending", { exact: true })).toBeTruthy());
  expect(page.getByRole("region", { name: "Publish Template" })).toBe(card);
  expect(page.queryByText("Published")).toBeNull();
  expect(page.getByRole("link", { name: "View submission" }).classList.contains("primary")).toBe(
    true,
  );
  expect(status()).toBe("Pending");
  expect(page.getAllByRole("status")).toEqual([card.querySelector("header [role=status]")]);
  expect(card.textContent).not.toMatch(/email/i);
  request.mockRejectedValue(new Error("offline"));
  await flow.checkPublication();
  await waitForSolid(() =>
    expect(page.getByText("Status is temporarily unavailable. We’ll check again.")).toBeTruthy(),
  );
  expect(status()).toBe("Pending");
  expect(page.getByRole("link", { name: "View submission" }).getAttribute("href")).toBe(
    `${pendingPublication.url}?view=submission`,
  );
});

it.each(["none", "unconfirmed", "transport"])(
  "keeps %s failure honest and never silently resubmits",
  async (effect) => {
    const { page, request } = await fixture();
    const card = page.getByRole("region", { name: "Publish Template" });
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
      expect(page.getByText(effect === "none" ? "Not published" : "Unconfirmed")).toBeTruthy(),
    );
    expect(page.getByRole("region", { name: "Publish Template" })).toBe(card);
    expect(page.queryByText("Published")).toBeNull();
    if (effect !== "none") {
      expect(page.queryByRole("button", { name: /^Retry$/ })).toBeNull();
      const lookup = createDeferred<unknown>();
      request.mockImplementationOnce(() => lookup.promise);
      fireEvent.click(page.getByRole("button", { name: /^Check status$/ }));
      await waitForSolid(() =>
        expect(
          page.getByRole("button", { name: "Checking…", busy: true }).matches(":disabled"),
        ).toBe(true),
      );
      expect(page.queryByRole("button", { name: "Publish" })).toBeNull();
      lookup.resolve({ ...reviewed, publicationState: { status: "unconfirmed" } });
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
  const remounted = mountInline(context);
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

it("retires the stale preview while the draft changes and offers only the refreshed archive", async () => {
  const { page, request, flow } = await fixture();
  fireEvent.click(page.getByRole("button", { name: "Preview" }));
  await waitForSolid(() => expect(page.getByRole("dialog")).toBeTruthy());
  const oldPublish = within(page.getByRole("dialog")).getByRole("button", { name: "Publish" });
  const updated = { ...reviewed, revision: "c".repeat(64), reviewToken: "d".repeat(64) };
  request.mockResolvedValueOnce({
    revision: updated.revision,
    content: JSON.stringify({ scope: {} }),
  });
  await vi.advanceTimersByTimeAsync(2500);
  await waitForSolid(() => expect(page.queryByRole("dialog")).toBeNull());
  expect(page.getByRole("button", { name: "Preparing…", busy: true }).matches(":disabled")).toBe(
    true,
  );
  expect(page.queryByRole("button", { name: "Publish" })).toBeNull();
  await flow.publish();
  expect(request.mock.calls.some(([m]) => m === "templates.drafts.publish")).toBe(false);

  request.mockResolvedValueOnce({
    revision: "e".repeat(64),
    content: JSON.stringify({ scope: reviewed.scope }),
  });
  request.mockRejectedValueOnce(new Error("Draft read failed"));
  await vi.advanceTimersByTimeAsync(2500);
  await waitForSolid(() => expect(page.getByText("Draft unavailable")).toBeTruthy());
  expect(page.getByRole("alert").textContent).toContain("Draft read failed");
  request.mockResolvedValueOnce(updated);
  fireEvent.click(page.getByRole("button", { name: "Try again" }));
  await waitForSolid(() => expect(page.getByRole("button", { name: "Publish" })).toBeTruthy());
  fireEvent.click(oldPublish);
  expect(request.mock.calls.some(([m]) => m === "templates.drafts.publish")).toBe(false);
});

it("shares the draft through sidebar handoff and remounts revised metadata before publication", async () => {
  const { page, flow, context, request } = await fixture();
  expect(templateCreatorFlow(context, target)).toBe(flow);
  const inline = mountInline(context);
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
  const remounted = mountInline(context);
  await vi.advanceTimersByTimeAsync(0);
  expect(
    request.mock.calls.findLast(([method]) => method === "templates.drafts.review")?.[1],
  ).toEqual({ agentId: target.agentId, draftId: target.draftId });
  await waitForSolid(() =>
    expect(remounted.getByRole("heading", { name: "Revised Brief" })).toBeTruthy(),
  );
  fireEvent.click(remounted.getByRole("button", { name: "Preview" }));
  await waitForSolid(() =>
    expect(remounted.getByRole("dialog", { name: "Preview Template" })).toBeTruthy(),
  );
  const preview = within(remounted.getByRole("dialog", { name: "Preview Template" }));
  expect(preview.getByRole("heading", { name: "Revised Brief" })).toBeTruthy();
  fireEvent.click(preview.getByRole("button", { name: "Publish" }));
  await waitForSolid(() => expect(remounted.queryByRole("dialog")).toBeNull());
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
  await waitForSolid(() =>
    expect(presentation.getByRole("button", { name: "Publishing", busy: true })).toBeTruthy(),
  );
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
