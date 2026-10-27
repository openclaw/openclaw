import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import type { SessionDiffFile } from "../../../packages/gateway-protocol/src/index.js";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
  type ControlUiMockGatewayScenario,
} from "../test-helpers/control-ui-e2e.ts";
import { diffResponse, nextPaint, singleFileDiff } from "./chat-session-diff.test-support.ts";
import {
  activateChatHeaderPanelAction,
  focusChatSidePanel,
  openChatSidePanelType,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "session diff panel",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let artifactDir: string;
beforeEach(() => {
  if (captureProof) {
    artifactDir = createControlUiE2eArtifactDir("diff-highlighting");
  }
});

const APP_PATCH = [
  "@@ -30,3 +30,4 @@",
  " // context line",
  '-const message = "removed line";',
  '+const message = "replacement line";',
  '+console.log("extra line");',
  " // trailing context",
].join("\n");

const APP_FILE_TEXT = [
  ...Array.from({ length: 29 }, (_, index) => `// unchanged line ${index + 1}`),
  "// context line",
  'const message = "replacement line";',
  'console.log("extra line");',
  "// trailing context",
  "",
].join("\n");

const NOTES_PATCH = [
  "diff --git a/notes.md b/notes.md",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/notes.md",
  "@@ -0,0 +1,2 @@",
  "+# Notes",
  "+scratch",
  "",
].join("\n");

const APP_FILE: SessionDiffFile = {
  path: "src/app.ts",
  status: "modified",
  additions: 2,
  deletions: 1,
  patch: APP_PATCH,
};
const NOTES_FILE: SessionDiffFile = {
  path: "notes.md",
  status: "added",
  additions: 2,
  deletions: 0,
  untracked: true,
  patch: NOTES_PATCH,
};
const SESSION_DIFF_RESPONSE = diffResponse([APP_FILE, NOTES_FILE], {
  root: "/tmp/checkout",
  branch: "feature/panel",
  baseRef: "main",
});

const emptyWorkspace = (sessionKey = "main") => ({
  sessionKey,
  root: "/tmp/checkout",
  gitCheckout: true,
  files: [],
  browser: { path: "", entries: [] },
});
async function openDiff(
  methodResponses: ControlUiMockGatewayScenario["methodResponses"],
  options: {
    sessionKey?: string;
    layouts?: string[];
    extraMethods?: string[];
    viewport?: { width: number; height: number };
  } = {},
) {
  const context = await suite.newBrowserContext({
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: options.viewport ?? { height: 800, width: 1180 },
  });
  const page = await context.newPage();
  if (options.layouts) {
    await seedPersistedReviewLayouts(page, options.layouts);
  }
  const gateway = await installMockGateway(page, {
    sessionKey: options.sessionKey,
    featureMethods: [
      "chat.metadata",
      "chat.startup",
      "sessions.diff",
      ...(options.extraMethods ?? []),
    ],
    methodResponses,
  });
  await page.goto(
    options.sessionKey
      ? controlUiSessionUrl(suite.server.baseUrl, options.sessionKey)
      : `${suite.server.baseUrl}chat`,
  );
  return { page, gateway };
}
const requestCount = (
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  method = "sessions.diff",
) => expect.poll(async () => (await gateway.getRequests(method)).length);
const text = (scope: Page | Locator, selector: string) =>
  expect.poll(() => scope.locator(selector).textContent());

async function waitForSessionDiff(page: Page): Promise<void> {
  await expect.poll(() => page.locator(".session-diff").count()).toBe(1);
  await expect
    .poll(() => page.locator(".session-diff__filename").allTextContents())
    .toEqual(["app.ts", "notes.md"]);
}

async function seedPersistedReviewLayouts(page: Page, sessionKeys: string[]): Promise<void> {
  const column = {
    id: "side-panel-column",
    side: "right",
    panels: [{ id: "detail", slot: "detail" }],
    activePanelId: "detail",
    height: 360,
    width: 360,
  };
  const layout = { columns: [column], open: true, expanded: false };
  const value = JSON.stringify({
    sessionKey: sessionKeys[0],
    lastActiveSessionKey: sessionKeys[0],
    sidebarSessionLayouts: Object.fromEntries(sessionKeys.map((key) => [key, layout])),
  });
  await page.addInitScript(({ key, serialized }) => localStorage.setItem(key, serialized), {
    key: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
    serialized: value,
  });
}

suite.define(() => {
  it("aligns replacement lines after an insertion and highlights only edited tokens", async () => {
    const before = [
      "const retries = 2;",
      "const timeout = 3000;",
      'const label = "Working";',
      "return { owner, retries, timeout, label };",
      "const café = '😀';",
      "const spacing={ value: 1 };",
      "const repeated = 1;",
      "const repeated = 1;",
    ];
    const after = [
      'const auditLabel = "session:" + owner;',
      "const retries = 3;",
      "const timeout = 5000;",
      'const label = "Running";',
      "return { owner, retries, timeout, label, auditLabel };",
      "const café = '🚀';",
      "const spacing = {value: 1};",
      "const repeated = 2;",
      "const repeated = 2;",
    ];
    const { page } = await openDiff(
      {
        "sessions.diff": singleFileDiff(
          "src/retry.ts",
          [
            `@@ -10,${before.length + 2} +10,${after.length + 2} @@`,
            " function run(owner: string) {",
            ...before.map((line) => "-  " + line),
            ...after.map((line) => "+  " + line),
            " }",
          ].join("\n"),
          after.length,
          before.length,
          {
            root: "/workspace/example",
            branch: "feature/retries",
            baseRef: "main",
          },
        ),
      },
      { viewport: { width: 1600, height: 650 } },
    );
    await activateChatHeaderPanelAction(page, "Show session changes");
    await focusChatSidePanel(page);
    const panel = page.locator(".session-diff");
    await panel.locator(".session-diff__file-toggle").click();
    await panel.getByRole("button", { name: "Diff mode: auto. Switch to next mode" }).click();
    await panel.getByRole("button", { name: "Diff mode: unified. Switch to next mode" }).click();
    const split = panel.locator(".session-diff-split");
    await split.locator(".tok-keyword").first().waitFor();
    if (captureProof) {
      const frame = await takeControlUiScreenshotFrame(page, panel, [split], {
        animations: "disabled",
        elements: [panel],
      });
      await writeFile(path.join(artifactDir, "replacement-split.png"), frame.elements[0]!.png);
    }
    const rows = await split
      .locator(".session-diff-split__row--pair")
      .evaluateAll((elements) =>
        elements.map((row) =>
          ["left", "right"].map(
            (side) =>
              row
                .querySelector(`.session-diff-split__side--${side} .session-diff-split__text`)
                ?.textContent?.trim() ?? "",
          ),
        ),
      );
    expect(rows).toEqual([["", after[0]], ...before.map((line, i) => [line, after[i + 1]])]);
    const changedText = (selector: string) =>
      panel
        .locator(selector)
        .evaluateAll((elements) =>
          elements
            .map((element) =>
              Array.from(
                element.querySelectorAll(".chat-diff__change--add, .chat-diff__change--del"),
                (span) => span.textContent,
              ).join(""),
            )
            .filter(Boolean),
        );
    const leftChanges = ["2", "3000", "Working", "😀", "{ ", "1", "1"];
    const rightChanges = ["3", "5000", "Running", ", auditLabel", "🚀", " {", "2", "2"];
    expect(await changedText(".session-diff-split__side--left")).toEqual(leftChanges);
    expect(await changedText(".session-diff-split__side--right")).toEqual(rightChanges);
    await panel.getByRole("button", { name: "Diff mode: split. Switch to next mode" }).click();
    await panel.getByRole("button", { name: "Diff mode: auto. Switch to next mode" }).click();
    await expect.poll(() => changedText(".chat-diff__row--add")).toEqual(rightChanges);
  });

  it("opens a renamed session diff when Review is added from the panel menu", async () => {
    const { page } = await openDiff({
      "sessions.files.list": emptyWorkspace(),
      "sessions.diff": {
        ...SESSION_DIFF_RESPONSE,
        files: [
          {
            path: "example.ts",
            oldPath: "example.html",
            status: "renamed",
            additions: 1,
            deletions: 1,
            patch:
              '@@ -1 +1 @@\n-<section data-mode="before">Hello</section>\n+const value = "after";',
          },
        ],
        additions: 1,
      },
    });

    await openChatSidePanelType(page, "Files");
    await openChatSidePanelType(page, "Review");

    await text(page, ".session-diff__old-path").toContain("example.html");
    await page.locator(".session-diff__file-toggle").click();
    await text(page, ".chat-diff__row--del .tok-propertyName").toBe("data-mode");
    await text(page, ".chat-diff__row--add .tok-keyword").toBe("const");
  });

  it("requests the default session diff once across subsequent pane renders", async () => {
    const { page, gateway } = await openDiff(
      {
        "sessions.files.list": emptyWorkspace(),
        "sessions.diff": SESSION_DIFF_RESPONSE,
      },
      { extraMethods: ["sessions.companion.state"] },
    );

    await openChatSidePanelType(page, "Files");
    await openChatSidePanelType(page, "Review");
    await waitForSessionDiff(page);
    await requestCount(gateway).toBe(1);

    await openChatSidePanelType(page, "Side chat");
    await expect
      .poll(() => page.locator(".tabstrip-tab__label").allTextContents())
      .toContain("Side chat");
    await nextPaint(page);

    expect(await gateway.getRequests("sessions.diff")).toHaveLength(1);
  });

  it("keeps each session's diff isolated and preserves closed files on return", async () => {
    const firstSessionKey = "agent:main:first-review";
    const secondSessionKey = "agent:main:second-review";
    const { page, gateway } = await openDiff(
      {
        "sessions.list": {
          count: 2,
          defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
          path: "",
          sessions: [
            { key: firstSessionKey, kind: "direct", updatedAt: 2 },
            { key: secondSessionKey, kind: "direct", updatedAt: 1 },
          ],
          ts: Date.now(),
        },
        "sessions.diff": {
          cases: [
            {
              match: { sessionKey: firstSessionKey },
              response: { ...SESSION_DIFF_RESPONSE, sessionKey: firstSessionKey },
            },
            {
              match: { sessionKey: secondSessionKey },
              response: {
                ...SESSION_DIFF_RESPONSE,
                sessionKey: secondSessionKey,
                files: [
                  {
                    ...NOTES_FILE,
                    path: "second.md",
                    patch: NOTES_PATCH.replaceAll("notes.md", "second.md"),
                  },
                ],
                additions: 2,
                deletions: 0,
              },
            },
          ],
        },
      },
      { sessionKey: firstSessionKey, layouts: [firstSessionKey, secondSessionKey] },
    );
    await waitForSessionDiff(page);
    const presentedFiles = page.locator(
      'openclaw-chat-pane[aria-hidden="false"] .session-diff__filename',
    );
    const firstFileToggle = page.locator(".session-diff__file-toggle").first();
    expect(await firstFileToggle.getAttribute("aria-expanded")).toBe("false");
    await firstFileToggle.click();
    await expect.poll(() => firstFileToggle.getAttribute("aria-expanded")).toBe("true");
    await expect
      .poll(() => page.locator(".chat-diff__row--add").first().textContent())
      .toContain("replacement line");
    await firstFileToggle.click();
    await expect.poll(() => firstFileToggle.getAttribute("aria-expanded")).toBe("false");

    await navigateToControlUiSession(page, secondSessionKey);

    await expect.poll(() => presentedFiles.allTextContents()).toEqual(["second.md"]);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.diff")).at(-1)?.params)
      .toMatchObject({ sessionKey: secondSessionKey });
    expect(
      await firstFileToggle.evaluate((element) =>
        element.closest("openclaw-chat-pane")?.getAttribute("aria-hidden"),
      ),
    ).toBe("true");

    await navigateToControlUiSession(page, firstSessionKey);
    await expect.poll(() => presentedFiles.allTextContents()).toEqual(["app.ts", "notes.md"]);
    expect(await firstFileToggle.getAttribute("aria-expanded")).toBe("false");
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(2);
  });

  it("lets Review report a non-git session without listing workspace files", async () => {
    const { page, gateway } = await openDiff({
      "sessions.diff": {
        sessionKey: "main",
        root: "/tmp/plain-workspace",
        files: [],
        additions: 0,
        deletions: 0,
        unavailableReason: "not_git",
      },
    });
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(0);

    await openChatSidePanelType(page, "Review");

    await expect
      .poll(() => page.locator(".session-diff .session-diff__note").textContent())
      .toContain("not a git checkout");
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(1);
  });

  it("opens the diff sidebar with per-file patches and gap markers", async () => {
    const metadata = {
      aheadCount: 2,
      commits: [
        { sha: "def5678", subject: "Second feature change" },
        { sha: "abc1234", subject: "First feature change" },
      ],
      mergeBase: { sha: "0011223", subject: "Initial commit" },
    };
    const diffCase = (match: Record<string, string>, files: SessionDiffFile[]) => ({
      match,
      response: diffResponse(files, { ...SESSION_DIFF_RESPONSE, ...metadata }),
    });
    const { page, gateway } = await openDiff(
      {
        "sessions.files.get": {
          sessionKey: "main",
          root: "/tmp/checkout",
          file: {
            path: "src/app.ts",
            workspacePath: "src/app.ts",
            name: "app.ts",
            kind: "modified",
            missing: false,
            previewKind: "text",
            contentEncoding: "utf8",
            content: APP_FILE_TEXT,
          },
        },
        "sessions.diff": {
          cases: [
            diffCase({ scope: "uncommitted" }, [NOTES_FILE]),
            diffCase({ scope: "commit", commit: "abc1234" }, [APP_FILE]),
            diffCase({ scope: "all" }, [
              APP_FILE,
              NOTES_FILE,
              {
                path: "logo.png",
                status: "modified",
                additions: 0,
                deletions: 0,
                binary: true,
              },
            ]),
          ],
        },
      },
      { extraMethods: ["sessions.files.get"] },
    );

    await activateChatHeaderPanelAction(page, "Show session changes");

    const panel = page.locator(".session-diff");
    await expect.poll(() => panel.count()).toBe(1);
    const panelSurface = page.locator('[data-panel-slot="detail"]').filter({ has: panel });
    await expect
      .poll(() => panelSurface.evaluate((element) => element.getBoundingClientRect().width))
      .toBe(480);
    const scopeControl = panel.getByRole("button", { name: "Choose change scope", exact: true });
    await expect.poll(() => scopeControl.textContent()).toBe("All Changes");
    await panel.getByRole("button", { name: "Change view options" }).click();
    await page.getByRole("menuitem", { name: "Sync Locally", exact: true }).click();
    const sync = page.getByRole("menu", { name: "Sync Locally", exact: true });
    await sync.getByText("/tmp/checkout", { exact: true }).waitFor();
    await sync.getByText("feature/panel", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await expect
      .poll(async () =>
        (await panel.locator(".session-diff__summary .chat-diffstat").textContent())?.replace(
          /\s/g,
          "",
        ),
      )
      .toBe("+4-1");

    const files = panel.locator(".session-diff__file");
    await expect.poll(() => files.count()).toBe(3);

    const modified = files.first();
    const firstRowText = (selector: string) =>
      expect.poll(() => modified.locator(selector).first().textContent());
    await text(modified, ".session-diff__filename").toBe("app.ts");
    await text(modified, ".session-diff__directory").toBe("src/");
    await modified.locator(".session-diff__file-toggle").click();
    // Hunk starting at old line 30 renders a leading expandable gap marker.
    await firstRowText(".chat-diff__row--skip").toContain("29 unmodified lines");
    await firstRowText(".chat-diff__row--add").toContain("replacement line");
    await text(modified, ".chat-diff__row--add .tok-keyword").toBe("const");
    expect(
      await modified
        .locator(".chat-diff__row--add .tok-keyword")
        .evaluate(
          (token) => getComputedStyle(token).color !== getComputedStyle(token.parentElement!).color,
        ),
    ).toBe(true);
    if (captureProof) {
      await panelSurface.screenshot({ path: path.join(artifactDir, "unified-light.png") });
    }

    const unchangedLines = () =>
      modified
        .locator(".chat-diff__text")
        .allTextContents()
        .then((lines) => lines.filter((line) => line.startsWith("// unchanged line ")));
    const expectedContext = Array.from(
      { length: 29 },
      (_, index) => "// unchanged line " + (index + 1),
    );
    await modified.getByRole("button", { name: "29 unmodified lines", exact: true }).click();
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(2);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.files.get"))[0]?.params)
      .toMatchObject({ path: "src/app.ts" });
    await expect.poll(unchangedLines).toEqual(expectedContext);
    await modified.getByRole("button", { name: "Hide 29 unmodified lines", exact: true }).click();
    await expect.poll(unchangedLines).toEqual([]);
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(2);
    await modified.getByRole("button", { name: "29 unmodified lines", exact: true }).click();
    await expect.poll(unchangedLines).toEqual(expectedContext);
    await expect.poll(async () => (await gateway.getRequests("sessions.files.get")).length).toBe(1);
    await expect.poll(async () => (await gateway.getRequests("sessions.diff")).length).toBe(3);

    await text(files.nth(1), ".session-diff__badge").toContain("untracked");

    const binary = files.nth(2);
    await binary.locator(".session-diff__file-toggle").click();
    await expect
      .poll(() => binary.locator(".session-diff__note").textContent())
      .toContain("Binary file");

    await panel.getByRole("button", { name: "Change view options" }).click();
    await page.getByRole("menuitemradio", { name: "Split", exact: true }).click();
    await expect.poll(() => modified.locator(".session-diff-split").count()).toBe(1);
    await text(modified, ".session-diff-split__side--right .tok-keyword").toBe("const");
    if (captureProof) {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.evaluate(() => {
        document.documentElement.dataset.themeMode = "dark";
        document.documentElement.dataset.themeResolved = "dark";
      });
      await modified
        .locator(".session-diff-split__side--right .tok-keyword")
        .scrollIntoViewIfNeeded();
      await panelSurface.screenshot({ path: path.join(artifactDir, "split-dark.png") });
    }
    await panel.getByRole("button", { name: "Change view options" }).click();
    await page.getByRole("menuitemradio", { name: "Unified", exact: true }).click();
    await expect.poll(() => modified.locator(".chat-diff").count()).toBe(1);
    // View-only toggles reuse parsed patches after the expansion revalidations.
    await requestCount(gateway).toBe(3);

    await modified.locator(".session-diff__file-toggle").click();
    await expect.poll(() => modified.locator(".chat-diff").count()).toBe(0);
    await panel.getByRole("button", { name: "Refresh changes" }).click();
    await requestCount(gateway).toBe(4);
    // Refresh keeps the current collapse state instead of expanding every file.
    await expect.poll(() => modified.locator(".chat-diff").count()).toBe(0);
    await modified.locator(".session-diff__file-toggle").click();
    await expect.poll(() => modified.locator(".chat-diff").count()).toBe(1);

    // The native scope control owns both uncommitted and individual-commit navigation.
    await gateway.deferNext("sessions.diff");
    await scopeControl.click();
    await page.getByRole("menuitemradio", { name: "Uncommitted", exact: true }).click();
    await expect.poll(() => panel.locator("openclaw-panel-loading-skeleton").count()).toBe(1);
    expect(await panel.locator(".session-diff__file").count()).toBe(0);
    await gateway.resolveDeferred("sessions.diff");
    await expect.poll(() => scopeControl.textContent()).toBe("Uncommitted");
    await expect.poll(() => panel.locator(".session-diff__file").count()).toBe(1);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.diff")).at(-1)?.params)
      .toMatchObject({ scope: "uncommitted" });

    await gateway.deferNext("sessions.diff");
    await scopeControl.click();
    await page.getByRole("menuitem", { name: "Commits", exact: true }).click();
    await page
      .getByRole("menuitemradio", { name: "abc1234 First feature change", exact: true })
      .click();
    await expect.poll(() => panel.locator("openclaw-panel-loading-skeleton").count()).toBe(1);
    expect(await panel.locator(".session-diff__file").count()).toBe(0);
    await gateway.resolveDeferred("sessions.diff");
    await expect.poll(() => scopeControl.textContent()).toBe("abc1234 First feature change");
    await expect
      .poll(async () => (await gateway.getRequests("sessions.diff")).at(-1)?.params)
      .toMatchObject({ scope: "commit", commit: "abc1234" });
    await panel.locator(".session-diff__file-toggle").click();
    await panel.getByLabel("29 unmodified lines", { exact: true }).waitFor();
    expect(await panel.locator(".session-diff__context-toggle").count()).toBe(0);
  });

  it("follows checkout binding in Review and Files and keeps diffs visible while refreshing", async () => {
    const sessionKey = "agent:main:pending-checkout";
    const { page, gateway } = await openDiff(
      {
        "sessions.diff": { ...SESSION_DIFF_RESPONSE, sessionKey },
        "sessions.files.list": { sessionKey, files: [] },
      },
      { sessionKey },
    );
    await openChatSidePanelType(page, "Review");
    await waitForSessionDiff(page);
    const panel = page.locator(".session-diff");
    const filenames = panel.locator(".session-diff__filename");
    const boundDiff = {
      ...SESSION_DIFF_RESPONSE,
      sessionKey,
      root: "/tmp/prepared-worktree",
      files: [SESSION_DIFF_RESPONSE.files[1]],
      additions: 2,
      deletions: 0,
    };
    await gateway.setMethodResponse("sessions.diff", boundDiff);
    await gateway.deferNext("sessions.diff");
    const projectEvent = { sessionKey, agentId: "main", reason: "project" };
    await gateway.emitGatewayEvent("sessions.changed", projectEvent);
    await requestCount(gateway).toBe(2);
    await expect.poll(() => panel.locator("openclaw-panel-loading-skeleton").count()).toBe(1);
    expect(await filenames.allTextContents()).toEqual([]);
    await gateway.resolveDeferred("sessions.diff");
    await expect.poll(() => filenames.allTextContents()).toEqual(["notes.md"]);
    expect(await panel.isVisible()).toBe(true);
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);

    await gateway.deferNext("sessions.diff");
    await gateway.setMethodResponse("sessions.diff", { ...SESSION_DIFF_RESPONSE, sessionKey });
    await gateway.emitChatFinal({ sessionKey, runId: "refresh-run", text: "Updated files." });
    await requestCount(gateway).toBe(3);
    await expect.poll(() => panel.getAttribute("aria-busy")).toBe("true");
    if (captureProof) {
      await page.locator('[data-panel-slot="detail"]').screenshot({
        path: path.join(artifactDir, "refresh-pending.png"),
      });
    }
    expect(await filenames.allTextContents()).toEqual(["notes.md"]);
    expect(await panel.locator("openclaw-panel-loading-skeleton").count()).toBe(0);
    expect(await panel.getByRole("button", { name: "Refresh changes" }).isDisabled()).toBe(true);
    expect(
      await panel
        .locator(".session-diff__refresh svg")
        .evaluate((icon) => getComputedStyle(icon).animationName),
    ).toBe("btn-spinner-spin");
    await gateway.resolveDeferred("sessions.diff");
    await expect.poll(() => panel.getAttribute("aria-busy")).toBe("false");
    await expect.poll(() => filenames.allTextContents()).toEqual(["app.ts", "notes.md"]);

    await openChatSidePanelType(page, "Files");
    await requestCount(gateway, "sessions.files.list").toBe(1);
    await gateway.setMethodResponse("sessions.files.list", {
      sessionKey,
      root: boundDiff.root,
      files: [],
      browser: { path: "", entries: [{ kind: "file", name: "notes.md", path: "notes.md" }] },
    });
    await gateway.emitGatewayEvent("sessions.changed", projectEvent);
    await requestCount(gateway, "sessions.files.list").toBe(2);
    await page
      .locator(".workspace-desktop")
      .getByRole("button", { name: "notes.md", exact: true })
      .waitFor();
  });

  it("refreshes an open Review after checkout creation without listing workspace files", async () => {
    const { page, gateway } = await openDiff({
      "sessions.diff": {
        sessionKey: "main",
        files: [],
        additions: 0,
        deletions: 0,
        unavailableReason: "not_git",
      },
    });
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(0);
    await activateChatHeaderPanelAction(page, "Show session changes");
    await text(page, ".session-diff .session-diff__note").toContain("not a git checkout");
    expect(await gateway.getRequests("sessions.diff")).toHaveLength(1);

    await gateway.setMethodResponse("sessions.diff", {
      ...SESSION_DIFF_RESPONSE,
      files: [NOTES_FILE],
      additions: 2,
      deletions: 0,
    });
    await gateway.emitChatFinal({ runId: "git-init-run", text: "Initialized repository." });
    await requestCount(gateway).toBe(2);
    await expect
      .poll(() => page.locator(".session-diff__filename").allTextContents())
      .toEqual(["notes.md"]);
    expect(await gateway.getRequests("sessions.files.list")).toHaveLength(0);
  });
});
