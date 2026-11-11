import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createDarkDesktopControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cloud workspace conflict recovery",
  // Native clipboard contents are shared across contexts in the same browser.
  browserLaunchOptions: { headless: true },
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
const sessionKey = "agent:main:conflict-proof";
const workerFailureDiagnostic = [
  "Worker provider rejected profile: node enrollment setup failed with exit code 1: provider reported lease destroyed",
  "<img src=x onerror=alert(1)>",
  `Trace: ${"diagnostic-segment/".repeat(100)}`,
  ...Array.from({ length: 30 }, (_, index) => `    at enroll (worker.ts:${index + 1}:1)`),
  "Final diagnostic line: enrollment did not complete.",
].join("\n");

const conflictPaths: [string, string, string] = [
  "src/[local] 'file.ts",
  "ui/src/app.ts",
  "retained",
];
const conflict = {
  paths: conflictPaths,
  stagedResultRef: "refs/openclaw/worker-results/claim-proof",
  totalCount: 3,
};

async function verifyRecoveryCommands(commands: { inspect: string; take: string }[]) {
  for (const [shell, isolated, replaceKinds] of [
    ["bash", true, false],
    ["bash", true, true],
    ...(process.platform === "darwin" ? [["zsh", true, true] as const] : []),
    ["bash", false, true],
  ] as const) {
    const root = await mkdtemp(path.join(tmpdir(), "openclaw-conflict-commands-"));
    const git = (cwd: string, args: string[], input?: string) =>
      execFileSync("git", args, { cwd, input, encoding: "utf8" }).trimEnd();
    try {
      const base = path.join(root, "base repo");
      const workspace = path.join(root, "linked workspace");
      await mkdir(base);
      git(base, ["init", "-q"]);
      await mkdir(path.join(base, "retained"));
      await writeFile(path.join(base, "retained/old.txt"), "base\n");
      git(base, ["add", "retained"]);
      git(base, [
        "-c",
        "user.name=Proof",
        "-c",
        "user.email=proof@example.invalid",
        "commit",
        "-qm",
        "base",
        "--allow-empty",
      ]);
      git(base, ["worktree", "add", "--detach", "-q", workspace]);
      await rm(path.join(workspace, "retained"), { recursive: true });
      git(workspace, ["add", "-A", "--", "retained"]);
      git(workspace, ["config", "core.filemode", "false"]);
      const gitDir = git(workspace, ["rev-parse", "--absolute-git-dir"]);
      const storage = isolated
        ? path.join(gitDir, "openclaw-worker-results", "result-claim-proof")
        : gitDir;
      if (isolated) {
        git(base, ["init", "--bare", "-q", storage]);
      }
      const resultGit = (args: string[], input?: string) =>
        git(base, [`--git-dir=${storage}`, ...args], input);
      const contents = [
        "#!/bin/sh\nprintf cloud\\n\n",
        "../../src/[local] 'file.ts",
        "cloud child\n",
      ];
      const blobs = contents.map((content) => resultGit(["hash-object", "-w", "--stdin"], content));
      const sourceTree = resultGit(["mktree"], `100755 blob ${blobs[0]}\t[local] 'file.ts\n`);
      const appTree = resultGit(["mktree"], `120000 blob ${blobs[1]}\tapp.ts\n`);
      const uiTree = resultGit(["mktree"], `040000 tree ${appTree}\tsrc\n`);
      const retainedTree = resultGit(["mktree"], `100644 blob ${blobs[2]}\tnew file.txt\n`);
      const tree = resultGit(
        ["mktree"],
        `040000 tree ${sourceTree}\tsrc\n040000 tree ${uiTree}\tui\n040000 tree ${retainedTree}\tretained\n`,
      );
      const commit = resultGit([
        "-c",
        "user.name=Proof",
        "-c",
        "user.email=proof@example.invalid",
        "commit-tree",
        tree,
        "-m",
        "result",
      ]);
      resultGit(["update-ref", conflict.stagedResultRef, commit]);
      await mkdir(path.join(workspace, "src"));
      await writeFile(path.join(workspace, conflict.paths[0]), "local\n");
      git(workspace, ["add", "--", conflict.paths[0]]);
      if (replaceKinds) {
        await rm(path.join(workspace, conflict.paths[0]));
        await mkdir(path.join(workspace, conflict.paths[0]));
        await writeFile(path.join(workspace, conflict.paths[0], "local.txt"), "local child\n");
        await writeFile(path.join(workspace, "retained"), "local file\n");
        git(workspace, ["add", "-A", "--", conflict.paths[0], "retained"]);
        // The guidance asks users to move filesystem obstructions aside; the index still tracks them.
        await rm(path.join(workspace, conflict.paths[0]), { recursive: true });
        await rm(path.join(workspace, "retained"));
      }
      for (const [index, command] of commands.entries()) {
        const execute = (text: string) =>
          execFileSync(shell, ["-c", text], { cwd: path.join(workspace, "src"), encoding: "utf8" });
        if (index === 2) {
          expect(execute(command.inspect)).toContain("new file.txt");
        } else {
          expect(execute(command.inspect)).toBe(contents[index]);
        }
        expect.soft(() => execute(command.take), conflict.paths[index]).not.toThrow();
      }
      if (isolated) {
        await rm(storage, { recursive: true });
      }
      expect(await readFile(path.join(workspace, conflict.paths[0]), "utf8")).toBe(contents[0]);
      expect(await readlink(path.join(workspace, conflict.paths[1]))).toBe(contents[1]);
      expect(await readFile(path.join(workspace, "retained/new file.txt"), "utf8")).toBe(
        contents[2],
      );
      expect(git(workspace, ["ls-files", "-z", "--", conflict.paths[0], "retained"])).toBe(
        `retained/new file.txt\0${conflict.paths[0]}\0`,
      );
      for (const [index, entry] of [
        ...conflict.paths.slice(0, 2),
        "retained/new file.txt",
      ].entries()) {
        expect(git(workspace, ["show", `:${entry}`])).toBe(contents[index]!.trimEnd());
        expect(git(workspace, ["ls-files", "--stage", "--", entry])).toMatch(
          index === 0 ? /^100755 / : index === 1 ? /^120000 / : /^100644 /,
        );
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

const pageOptions = createDarkDesktopControlUiContextOptions();
function sessionList(label: string, placement: Record<string, unknown>, now = Date.now()) {
  const model = { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" };
  return {
    count: 1,
    defaults: model,
    path: "",
    ts: now,
    sessions: [
      {
        ...model,
        displayName: label,
        label,
        key: sessionKey,
        kind: "direct",
        hasActiveRun: false,
        status: "done",
        totalTokens: 0,
        updatedAt: now,
        placement: {
          createdAtMs: now - 10_000,
          updatedAtMs: now,
          stateChangedAtMs: now - 1_000,
          ...placement,
        },
      },
    ],
  };
}
function sessionsList(includeConflict: boolean) {
  return sessionList(includeConflict ? "Cloud conflict proof" : "Cloud conflict cleared", {
    state: "reclaimed",
    generation: 1,
    ...(includeConflict ? { workspaceResultConflict: conflict } : {}),
  });
}
function workerRecoverySessionsList(includeError: boolean, failedState = "failed") {
  const now = Date.now();
  return sessionList(
    "Cloud worker failure proof",
    {
      state: includeError ? failedState : "active",
      generation: 2,
      environmentId: "worker:lost-proof",
      activeOwnerEpoch: 4,
      ...(includeError
        ? {
            recoveryError: workerFailureDiagnostic,
            terminalReason:
              failedState === "failed" ? "stale terminal worker failure" : workerFailureDiagnostic,
            terminalAtMs: now,
          }
        : {}),
    },
    now,
  );
}

type History = NonNullable<Parameters<typeof installMockGateway>[1]>["historyMessages"];
const historyEvent = (customType: string, content: string, details?: unknown) => ({
  role: "custom",
  customType,
  content,
  details,
  timestamp: Date.now() - 500,
});
async function openSession(
  page: Page,
  historyMessages: History,
  roster = workerRecoverySessionsList(false),
) {
  const gateway = await installMockGateway(page, {
    historyMessages,
    methodResponses: { "sessions.list": roster },
    sessionKey,
  });
  expect((await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey)))?.status()).toBe(
    200,
  );
  return gateway;
}

suite.define(() => {
  it("shows, dismisses, and reloads durable conflict recovery guidance", async () => {
    const options = { ...pageOptions, permissions: ["clipboard-read", "clipboard-write"] };
    await suite.withPage(options, async ({ page }) => {
      const gateway = await openSession(
        page,
        [historyEvent("cloud-workspace-conflict", "3 cloud conflicts.", conflict)],
        sessionsList(true),
      );

      const notice = page.locator(".chat-workspace-conflict-notice");
      const sessionRow = page.locator(`[data-session-key="${sessionKey}"]`);
      await notice.waitFor({ timeout: 10_000 });
      await sessionRow.locator('.session-row-badge--cloud[data-workspace-conflicts="3"]').waitFor();
      const historyCard = page.locator(".chat-workspace-conflict-event");
      await historyCard.waitFor();
      expect(await notice.textContent()).toContain("3 cloud workspace conflicts");
      expect(await historyCard.textContent()).toContain(conflict.stagedResultRef);

      await page.setViewportSize({ width: 390, height: 844 });
      const composer = page.locator(".agent-chat__composer-shell");
      const title = notice.locator(".chat-composer-neighbor-card__copy strong");
      const dismiss = notice.getByRole("button", { name: "Dismiss workspace conflict notice" });
      await expect
        .poll(async () => {
          const [composerBox, noticeBox] = await Promise.all([
            composer.boundingBox(),
            notice.boundingBox(),
          ]);
          return composerBox && noticeBox ? Math.abs(composerBox.width - noticeBox.width) : null;
        })
        .toBeLessThanOrEqual(1);
      await expect
        .poll(() =>
          title.evaluate((node) =>
            [node, node.nextElementSibling!].map((item) => getComputedStyle(item).whiteSpace),
          ),
        )
        .toEqual(["nowrap", "nowrap"]);
      // Read the card and its children in one frame while the resized composer settles.
      const { noticeBox, itemBoxes } = await notice.evaluate((node) => {
        const bounds = (element: Element) => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        };
        return {
          noticeBox: bounds(node),
          itemBoxes: [
            ".chat-composer-neighbor-card__copy strong",
            ".chat-composer-neighbor-card__copy > span",
            ".chat-error__dismiss",
          ].map((selector) => bounds(node.querySelector(selector)!)),
        };
      });
      for (const itemBox of itemBoxes) {
        expect(itemBox.x).toBeGreaterThanOrEqual(noticeBox.x);
        expect(itemBox.x + itemBox.width).toBeLessThanOrEqual(noticeBox.x + noticeBox.width);
        expect(itemBox.y).toBeGreaterThanOrEqual(noticeBox.y);
        expect(itemBox.y + itemBox.height).toBeLessThanOrEqual(noticeBox.y + noticeBox.height);
      }

      await notice.locator(".chat-workspace-conflict-notice__summary").click();
      const commands = [];
      for (const row of await notice.locator(".chat-workspace-conflict-path-actions").all()) {
        const copied = [];
        for (const button of await row.locator("button").all()) {
          await page.evaluate(() => navigator.clipboard.writeText(""));
          await button.click();
          await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toBe("");
          copied.push(await page.evaluate(() => navigator.clipboard.readText()));
        }
        expect(copied).toHaveLength(2);
        commands.push({ inspect: copied[0]!, take: copied[1]! });
      }
      expect(commands).toHaveLength(3);
      await verifyRecoveryCommands(commands);

      await dismiss.click();
      await notice.waitFor({ state: "detached" });
      await historyCard.waitFor();

      await page.setViewportSize({ width: 1440, height: 900 });
      await gateway.setSessionsListResponse(sessionsList(false));
      await page.reload();
      await page.locator(".chat-workspace-conflict-event").waitFor({ timeout: 10_000 });
      await sessionRow.getByText("Cloud conflict cleared", { exact: true }).waitFor();
      expect(await page.locator(".chat-workspace-conflict-notice").count()).toBe(0);
      expect(await sessionRow.locator(".session-row-badge--cloud").count()).toBe(0);
      expect(await page.locator(".chat-workspace-conflict-event").textContent()).toContain(
        conflict.stagedResultRef,
      );
    });
  });

  it("renders durable failure notices from transcript history", async () => {
    const notices = [
      {
        customType: "cloud-workspace-recovery-failed",
        content:
          "Cloud workspace recovery attempt failed: snapshot verification failed. OpenClaw preserved the result and will retry.",
      },
      {
        customType: "run-failed-before-reply",
        content: "This turn did not run: Cloud worker is unavailable. Choose another runner.",
      },
    ];
    await suite.withPage(pageOptions, async ({ page }) => {
      await openSession(
        page,
        notices.map(({ customType, content }) => historyEvent(customType, content)),
      );
      for (const { content } of notices) {
        await page
          .locator(".chat-group.other")
          .filter({ hasText: content })
          .waitFor({ timeout: 10_000 });
      }
      expect(await page.locator(".chat-group.assistant").count()).toBe(0);
      await page.reload();
      for (const { content } of notices) {
        const notice = page.locator(".chat-group.other").filter({ hasText: content });
        await notice.waitFor({ timeout: 10_000 });
        expect(await notice.count()).toBe(1);
        expect(await notice.locator(".chat-sender-name").textContent()).toBe("Error");
      }
    });
  });

  it.each(["failed", "reclaimed", "request"])(
    "exposes the full %s diagnostic with keyboard and clipboard access",
    async (failedState) => {
      await suite.withPage(
        { ...pageOptions, permissions: ["clipboard-read", "clipboard-write"] },
        async ({ page }) => {
          const gateway = await openSession(page, [
            {
              role: "assistant",
              content: [{ type: "text", text: "Remote work completed successfully." }],
              timestamp: Date.now() - 2_000,
            },
          ]);
          await page.getByText("Remote work completed successfully.").waitFor({ timeout: 10_000 });
          await expect.poll(() => page.getByRole("alert").allTextContents()).toEqual([]);

          if (failedState === "request") {
            await gateway.setMethodResponse("sessions.patch", {
              __mockError: { code: "UNAVAILABLE", message: workerFailureDiagnostic },
            });
            await page.locator(".chat-pane__session-title-button").click();
            const rename = page.locator(".chat-pane__session-title-input");
            await rename.fill("Rejected rename");
            await rename.press("Enter");
            await gateway.waitForRequest("sessions.patch");
          } else {
            await gateway.setSessionsListResponse(workerRecoverySessionsList(true, failedState));
            await page.reload();
          }
          const alert = page
            .getByRole("alert")
            .filter({ hasText: "provider reported lease destroyed" });
          await alert.waitFor({ timeout: 10_000 });
          expect(await alert.textContent()).toContain("provider reported lease destroyed");
          expect(await alert.textContent()).not.toContain("stale terminal worker failure");
          const summary = alert.locator("summary");
          const copy = alert.getByRole("button", { name: "Copy error", exact: true });
          const diagnostic = alert.locator(".lazy-view-error__detail");
          const expected = `${failedState === "request" ? "" : "Couldn’t continue this session. Check its device and try again. "}${workerFailureDiagnostic}`;
          expect(await summary.count()).toBe(1);
          expect(await diagnostic.isVisible()).toBe(false);
          for (const width of [1440, 320]) {
            await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
            if (width === 320) {
              // Viewport changes retire the desktop sidebar asynchronously.
              await expect
                .poll(() =>
                  page
                    .locator(".sidebar")
                    .evaluate(
                      (node) =>
                        !node.checkVisibility({ checkOpacity: true }) ||
                        node.getBoundingClientRect().right <= 0,
                    ),
                )
                .toBe(true);
            }
            await summary.press("Enter");
            await diagnostic.waitFor({ state: "visible" });
            expect(await diagnostic.textContent()).toBe(expected);
            expect(await alert.locator("img").count()).toBe(0);
            const bounds = await diagnostic.evaluate((node) => {
              const box = node.getBoundingClientRect();
              return {
                edges: [box.left, innerWidth - box.right, box.top, innerHeight - box.bottom],
                overflowX: node.scrollWidth - node.clientWidth,
                overflowY: node.scrollHeight - node.clientHeight,
              };
            });
            expect(Math.min(...bounds.edges)).toBeGreaterThanOrEqual(0);
            expect(bounds.overflowX).toBeLessThanOrEqual(1);
            expect(bounds.overflowY).toBeGreaterThan(0);
            await page.keyboard.press("Tab");
            expect(await diagnostic.evaluate((node) => node === document.activeElement)).toBe(true);
            await page.keyboard.press("Tab");
            expect(await copy.evaluate((node) => node === document.activeElement)).toBe(true);
            await page.keyboard.press("Shift+Tab");
            await page.keyboard.press("PageDown");
            await expect
              .poll(() => diagnostic.evaluate((node) => node.scrollTop))
              .toBeGreaterThan(0);
            expect(
              await diagnostic.evaluate((node) => {
                const range = document.createRange();
                range.selectNodeContents(node);
                const selection = window.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
                return selection?.toString();
              }),
            ).toBe(expected);
            await copy.press("Enter");
            await expect
              .poll(() => page.evaluate(() => navigator.clipboard.readText()))
              .toBe(expected);
            await diagnostic.evaluate((node) => {
              window.getSelection()?.removeAllRanges();
              node.scrollTop = node.scrollHeight;
            });
            await summary.press("Space");
            await expect.poll(() => diagnostic.isVisible()).toBe(false);
            await alert
              .getByRole("button", { name: "Copy error", exact: true, includeHidden: true })
              .waitFor({ state: "attached" });
          }
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
          if (failedState === "request") {
            await alert.getByRole("button", { name: "Dismiss error" }).click();
            await alert.waitFor({ state: "detached" });
          }
        },
      );
    },
  );
});
