/* @vitest-environment jsdom */
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SessionWorkspaceGetResult } from "../../api/types.ts";
import { createReviewFixture } from "../../test-helpers/chat-pane-embedded-panels.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createGatewayBrowserClientFixture } from "./chat-application-context.test-support.ts";
import { resolveSessionDiffSidebarContent } from "./components/chat-session-workspace.ts";
import { createChatSidebarContainer } from "./components/chat-sidebar.test-support.ts";
import { openSlot } from "./sidebar-layout.ts";

function report(path = "report.md", content = "# Report\n") {
  return {
    sessionKey: "agent:main:review-intent",
    root: "/synthetic/workspace",
    file: {
      kind: "modified",
      path,
      name: path,
      missing: false,
      previewKind: "text",
      contentEncoding: "utf8",
      content,
      hash: "current",
    },
  } satisfies SessionWorkspaceGetResult;
}

async function review(options: { scopes: string[]; methods?: string[]; paths?: string[] }) {
  const fixture = createReviewFixture();
  const container = createChatSidebarContainer();
  fixture.mount.before(container);
  container.append(fixture.mount);
  const { state } = fixture;
  state.hello = gatewayHelloForMethods(
    options.methods ?? ["sessions.diff", "sessions.files.get", "sessions.files.set"],
    options.scopes,
  );
  state.client = createGatewayBrowserClientFixture({
    request: () => ({
      sessionKey: state.sessionKey,
      branch: "report-update",
      baseRef: "main",
      files: (options.paths ?? ["report.md"]).map((path) => ({
        path,
        status: "modified",
        additions: 1,
        deletions: 0,
      })),
      additions: 1,
      deletions: 0,
    }),
  });
  const content = resolveSessionDiffSidebarContent(state);
  if (content?.kind !== "session-diff") {
    throw new Error("Expected Review content");
  }
  content.presentation = { mobile: false };
  state.sidebarContent = content;
  state.updateSidebarLayout(openSlot(state.sidebarLayout, "detail"));
  await fixture.renderPanels();
  await waitForSolid(() =>
    expect(fixture.mount.querySelector(".session-diff__file-menu")).not.toBeNull(),
  );
  return fixture;
}

afterEach(() => document.body.replaceChildren());

const scenarios: {
  name: string;
  scopes: string[];
  result: SessionWorkspaceGetResult | Error;
  methods?: string[];
  editable: boolean;
}[] = [
  {
    name: "guest",
    scopes: ["operator.sessions.read", "operator.sessions.write"],
    result: report(),
    editable: false,
  },
  { name: "admin", scopes: ["operator.admin"], result: report(), editable: true },
  {
    name: "mixed endings",
    scopes: ["operator.admin"],
    result: report("report.md", "# Report\r\nText\n"),
    editable: false,
  },
  {
    name: "missing hash",
    scopes: ["operator.admin"],
    result: { ...report(), file: { ...report().file, hash: undefined } },
    editable: false,
  },
  {
    name: "unavailable write method",
    scopes: ["operator.admin"],
    result: report(),
    methods: ["sessions.diff", "sessions.files.get"],
    editable: false,
  },
  {
    name: "failed file read",
    scopes: ["operator.admin"],
    result: new Error("File unavailable"),
    editable: false,
  },
];

it.each(scenarios)(
  "offers Review editing only for the actual file capability: $name",
  async (scenario) => {
    const fixture = await review(scenario);
    if (scenario.result instanceof Error) {
      // The owner catches an RPC rejection; no permission answer is mocked.
      void fixture.file.promise.catch(() => {});
      fixture.file.reject(scenario.result);
    } else {
      fixture.file.resolve(scenario.result);
    }
    expectDefined(
      fixture.mount.querySelector<HTMLButtonElement>(".session-diff__file-menu"),
      "file menu",
    ).click();
    flush();
    await vi.dynamicImportSettled();
    await waitForSolid(() => {
      const menu = expectDefined(
        fixture.mount.querySelector("openclaw-session-diff-menu"),
        "Review menu",
      );
      expect(Boolean(menu.querySelector('button[value="edit"]'))).toBe(scenario.editable);
      expect(menu.querySelector('button[value="open-file"]')).not.toBeNull();
      expect(menu.querySelector('button[value="reading"]')).not.toBeNull();
      expect(menu.querySelector('button[value="highlighted"]')).not.toBeNull();
      expect(menu.querySelector('button[value="plain"]')).not.toBeNull();
    });
    expect(fixture.state.sessionWorkspaceState?.previews).toHaveLength(0);
  },
);

it("keeps a delayed edit capability with the menu that requested it", async () => {
  const fixture = await review({ scopes: ["operator.admin"], paths: ["report.md", "other.md"] });
  const first = createDeferred<SessionWorkspaceGetResult>();
  const second = createDeferred<SessionWorkspaceGetResult>();
  vi.mocked(fixture.sessions.getFile).mockImplementation((_key, path) =>
    path === "report.md" ? first.promise : second.promise,
  );
  const triggers = fixture.mount.querySelectorAll<HTMLButtonElement>(".session-diff__file-menu");
  expect(fixture.sessions.getFile).not.toHaveBeenCalled();
  expectDefined(triggers[0], "first file menu").click();
  flush();
  await waitForSolid(() => expect(fixture.sessions.getFile).toHaveBeenCalledTimes(1));
  expect(
    fixture.mount.querySelector('openclaw-session-diff-menu button[value="open-file"]'),
  ).not.toBeNull();
  expect(fixture.mount.querySelector('openclaw-session-diff-menu button[value="edit"]')).toBeNull();
  expectDefined(triggers[1], "second file menu").click();
  flush();
  await waitForSolid(() => expect(fixture.sessions.getFile).toHaveBeenCalledTimes(2));
  first.resolve(report());
  second.resolve(report("other.md", "# Other\r\nText\n"));
  await Promise.all([first.promise, second.promise]);
  await vi.dynamicImportSettled();
  flush();
  await waitForSolid(() =>
    expect(
      fixture.mount.querySelector('openclaw-session-diff-menu button[value="edit"]'),
    ).toBeNull(),
  );
  expect(fixture.state.sessionWorkspaceState?.previews).toHaveLength(0);
});
