import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { captureControlUiE2eFailureDiagnostics } from "../test-helpers/control-ui-e2e.ts";
import { confirmIme } from "./chat-flow.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";
import {
  createPageOpener,
  button,
  expectValue,
  waitForRequestCount,
  expectAttribute,
} from "./new-session-page.scenario.test-support.ts";
import {
  ONE_PIXEL_PNG_B64,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  captureUiProof,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  expectDecodedThumbnail,
  expectPendingNewSessionPresentation,
  installMockGateway,
  pollLocatorText,
  waitForCommittedChatRoute,
} from "./new-session-page.test-support.ts";
import { sessionList } from "./new-session-shard.test-support.ts";
import { waitForMobileSidebarDrawerOpen } from "./session-management.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const rosterMatch = { includeGlobal: true };
const SESSION_KEY = "agent:main:dashboard:0f403cb8-3920-4cf1-8eb7-79f2f00ce488";
const RUN_ID = "transition-proof-run";
const captureProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

type SessionTransitionFrames = {
  invalid: number;
  firstInvalid: {
    activeViewTransition: boolean;
    handoffCover: boolean;
    newSessionVisible: boolean;
    chatVisible: boolean;
    loadingSkeleton: boolean;
    routeId?: string;
    routeStatus?: string;
    loaderPending: boolean;
  } | null;
  running: boolean;
  chatSurfaceReady: boolean;
};

function transitionProofDir() {
  return path.join(suite.artifactDir, "new-session-transition");
}

function createdKey(params: unknown) {
  if (
    !params ||
    typeof params !== "object" ||
    !("key" in params) ||
    typeof params.key !== "string"
  ) {
    throw new Error("Expected a sessions.create key");
  }
  return params.key;
}

async function expectPlainJson(prompt: Locator, message: string) {
  const text = prompt.locator(".chat-text");
  await text.locator("pre code").waitFor({ state: "visible" });
  await pollLocatorText(text.locator("pre code")).toBe(message);
  expect(await text.locator("button, details, .code-block-wrapper").count()).toBe(0);
}

async function expectListedKeys(page: Page, keys: string[]) {
  for (const key of keys) {
    await expect
      .poll(() => page.locator(`.sidebar-recent-session[data-session-key="${key}"]`).count())
      .toBe(1);
  }
}

async function captureJson(name: string, value: () => unknown, dir = transitionProofDir()) {
  if (captureProofEnabled) {
    await writeFile(path.join(dir, name), JSON.stringify(await value(), null, 2));
  }
}

async function captureProof(page: import("playwright").Page, fileName: string) {
  if (!captureProofEnabled) {
    return;
  }
  const proofDir = transitionProofDir();
  await mkdir(proofDir, { recursive: true });
  if (page.video()) {
    await writeFile(
      path.join(proofDir, fileName),
      await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
        page
          .locator(
            ".new-session-page__message:visible, .agent-chat__composer-combobox textarea:visible",
          )
          .first(),
      ]),
    );
    return;
  }
  await page.screenshot({ fullPage: true, path: path.join(proofDir, fileName) });
}

type CreateRecoveryCase = {
  mode: "dark" | "light";
  motion: "no-preference" | "reduce";
  width: number;
  content: "markdown" | "json";
};
async function assertCreateRecovery(
  page: Page,
  { mode, motion, width, content }: CreateRecoveryCase,
) {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: mode, reducedMotion: motion });
  const proofName = `pending-${width}-${mode}-${motion}-${content}`;
  const sessionKey = "agent:main:locked-new-session-draft";
  const submittedSummary = "keep this submitted draft atomic";
  const fileReference = "src/example.ts";
  const referencedSessionKey = "agent:main:referenced-preview";
  const markdownMessage = [
    `**${submittedSummary}**`,
    "",
    "| Item | State |",
    "| --- | --- |",
    "| Lobster | Ready |",
    "",
    `References: ${fileReference} and ${referencedSessionKey}.`,
    "",
    "[Documentation](https://example.com/guide)",
    "",
    `![Inline marker](data:image/png;base64,${ONE_PIXEL_PNG_B64})`,
  ].join("\n");
  const submittedMessage =
    content === "json"
      ? JSON.stringify({ task: submittedSummary, files: [fileReference] }, null, 2)
      : markdownMessage;
  const runId = "submitted-image-run";
  const imageFileName = "apple-touch-icon.png";
  const imageFile = path.join(process.cwd(), "ui/public", imageFileName);
  const imageContent = (await readFile(imageFile)).toString("base64");
  const gateway = await installMockGateway(page, {
    subscriptionInitialHistory: false,
    heldMethods: ["chat.startup"],
    workspaceGit: true,
    methodResponses: {
      ...LOCAL_GIT_WORKSPACE_RESPONSES,
      "sessions.list": sessionList(),
      "sessions.create": { key: sessionKey, runId, runStarted: true, messageSeq: 1 },
      "chat.startup": {
        messages: [],
        sessionId: "submitted-image-session",
        sessionInfo: {
          activeRunIds: [runId],
          hasActiveRun: true,
          key: sessionKey,
          status: "running",
        },
      },
    },
  });
  await page.goto(`${suite.server.baseUrl}new`);
  await page.locator(".new-session-page__message").waitFor();
  await evaluateControlUiContext(
    page,
    (context, nextMode) => {
      context.theme.setMode(nextMode);
    },
    mode,
  );
  await expectAttribute(page.locator("html"), "data-theme-mode", mode);
  await gateway.deferNext("sessions.create");

  const message = page.locator(".new-session-page__message");
  const placeSelect = page.locator(".oc-popover.new-session-page__project-popover");
  const placeSummary = page.locator("#new-session-project-trigger");
  const startup = page.locator(".new-session-page__starting");
  const submittedPrompt = startup.locator(".chat-group.user");
  const announcement = page.locator(
    '.new-session-page:visible > [role="status"][aria-live="polite"], openclaw-pending-session-create:visible .chat-main__conversation > [role="status"][aria-live="polite"]',
  );
  const draftImage = page
    .locator(".chat-attachment-thumb")
    .getByRole("img", { name: imageFileName });

  await message.fill(submittedMessage);
  await page.locator(".agent-chat__photo-input").setInputFiles(imageFile);
  await expectDecodedThumbnail(draftImage);
  await page.locator(".agent-chat__file-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Pending attachment proof"),
  });
  await expect.poll(() => page.locator(".chat-attachment-thumb").count()).toBe(2);
  await placeSummary.click();
  expect(await placeSelect.evaluate((element) => element.matches(":popover-open"))).toBe(true);
  await button(page, "Start session").dblclick();

  const create = await gateway.waitForRequest("sessions.create");
  const submittedPayload = {
    message: submittedMessage,
    attachments: [
      {
        type: "image",
        mimeType: "image/png",
        fileName: imageFileName,
        content: imageContent,
      },
      {
        type: "file",
        mimeType: "text/plain",
        fileName: "notes.txt",
        content: Buffer.from("Pending attachment proof").toString("base64"),
      },
    ],
  };
  expect(create.params).toMatchObject(submittedPayload);
  await page.locator("openclaw-pending-session-create").waitFor();
  expect(new URL(page.url()).pathname).toBe("/new");
  expect(await page.locator("openclaw-chat-pane").count()).toBe(0);
  expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
  await expect.poll(() => submittedPrompt.isVisible()).toBe(true);
  if (content === "json") {
    await expectPlainJson(submittedPrompt, submittedMessage);
  } else {
    const pendingMarkdown = submittedPrompt.locator(".chat-text");
    await pollLocatorText(pendingMarkdown.locator("strong")).toBe(submittedSummary);
    await pendingMarkdown.getByRole("cell", { name: "Ready", exact: true }).waitFor();
    await pollLocatorText(pendingMarkdown).toContain(fileReference);
    await pollLocatorText(pendingMarkdown).toContain(referencedSessionKey);
    expect(
      await pendingMarkdown.getByRole("link", { name: "Documentation" }).getAttribute("href"),
    ).toBe("https://example.com/guide");
    await pendingMarkdown.locator("img.markdown-inline-image").waitFor({ state: "visible" });
    expect(
      await pendingMarkdown
        .locator("button, [role=button], [data-file-path], [data-session-key]")
        .count(),
    ).toBe(0);
  }
  const attachmentCard = submittedPrompt.locator(".chat-assistant-attachment-card--compact");
  await attachmentCard.getByText("notes.txt", { exact: true }).waitFor();
  const cardBox = await attachmentCard.boundingBox();
  expect(cardBox?.width).toBeLessThanOrEqual(width);
  expect(cardBox?.height).toBeGreaterThan(30);
  await expectDecodedThumbnail(submittedPrompt.locator("img.chat-message-image"));
  await pollLocatorText(startup.locator('.chat-working-indicator[role="status"]')).toContain(
    "Starting…",
  );
  await pollLocatorText(announcement).toContain("Starting…");
  expect(new URL(page.url()).pathname).toBe("/new");
  expect(await message.isVisible()).toBe(false);
  expect(await placeSelect.isVisible()).toBe(false);
  // The visible chat header now owns the titlebar, not a second draft-scroll inset.
  const pendingChat = page.locator("openclaw-pending-session-create");
  expect(await pendingChat.locator(".chat-pane__header").isVisible()).toBe(true);
  const followUpComposer = pendingChat.locator(".agent-chat__composer-combobox textarea");
  expect(await followUpComposer.isEnabled()).toBe(true);
  expect(await followUpComposer.inputValue()).toBe("");
  await captureUiProof(suite, page, `${proofName}-submitted.png`);
  const presentation = await expectPendingNewSessionPresentation(page);
  expect(presentation.reducedMotion).toBe(motion === "reduce");
  await captureJson(`${proofName}.json`, () => presentation, suite.artifactDir);
  // Motion changes the pending indicator's CSS, not create/retry ownership.
  const alternateMotion = motion === "reduce" ? "no-preference" : "reduce";
  await page.emulateMedia({ reducedMotion: alternateMotion });
  const alternatePresentation = await expectPendingNewSessionPresentation(page);
  expect(alternatePresentation.reducedMotion).toBe(alternateMotion === "reduce");
  const alternateProofName = `pending-${width}-${mode}-${alternateMotion}-${content}`;
  await captureUiProof(suite, page, `${alternateProofName}-submitted.png`);
  await captureJson(`${alternateProofName}.json`, () => alternatePresentation, suite.artifactDir);
  await page.emulateMedia({ reducedMotion: motion });
  await followUpComposer.press("Enter");
  await followUpComposer.press("Control+Enter");
  expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
  expect(await gateway.getRequests("chat.send")).toHaveLength(0);
  await submittedPrompt.locator(".chat-message-image-button").click();
  const attachmentViewer = page.locator("openclaw-image-lightbox");
  await expectDecodedThumbnail(attachmentViewer.locator("img.image"));
  expect(await attachmentViewer.locator("img.image").getAttribute("src")).toBe(
    `data:image/png;base64,${imageContent}`,
  );
  await page.keyboard.press("Escape");
  await attachmentViewer.waitFor({ state: "detached" });

  await gateway.rejectDeferred("sessions.create", {
    code: "UNAVAILABLE",
    message: "session creation unavailable",
  });
  await page.getByRole("alert").filter({ hasText: "session creation unavailable" }).waitFor();
  await expect.poll(() => message.isVisible()).toBe(true);
  await expect.poll(() => message.isDisabled()).toBe(false);
  expect(await startup.isVisible()).toBe(false);
  await expect.poll(async () => (await announcement.textContent())?.trim()).toBe("");
  expect(await message.inputValue()).toBe(submittedMessage);
  expect(await placeSummary.isDisabled()).toBe(false);
  await expectDecodedThumbnail(draftImage);
  await captureUiProof(suite, page, `${proofName}-restored.png`);

  await button(page, "Start session").click();
  await waitForRequestCount(gateway, 2, "sessions.create");
  const retry = (await gateway.getRequests("sessions.create")).at(-1);
  expect(retry?.params).toMatchObject(submittedPayload);
  await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
    timeout: 30_000,
  });
  await gateway.waitForRequest("chat.startup");
  await waitForCommittedChatRoute(page);
  const acceptedPrompt = page.locator(".chat-group.user");
  await expect.poll(() => acceptedPrompt.count()).toBe(1);
  await pollLocatorText(acceptedPrompt).toContain(submittedSummary);
  if (content === "markdown") {
    const acceptedMarkdown = acceptedPrompt.locator(".chat-text");
    await acceptedMarkdown
      .locator(`a[data-file-path="${fileReference}"]`)
      .waitFor({ state: "visible" });
    await acceptedMarkdown
      .locator(`a[data-session-key="${referencedSessionKey}"]`)
      .waitFor({ state: "visible" });
    await button(acceptedMarkdown, "Open image Inline marker", true).waitFor({ state: "visible" });
    await button(acceptedMarkdown, "Expand table", true).click();
    const expandedTable = page.locator("openclaw-modal-dialog.markdown-table-modal");
    await page.getByRole("dialog", { name: "Expanded table", exact: true }).waitFor();
    await expandedTable.getByRole("cell", { name: "Ready", exact: true }).waitFor();
    await button(expandedTable, "Close expanded table", true).click();
    await expandedTable.waitFor({ state: "detached" });
  } else {
    await expectPlainJson(acceptedPrompt, submittedMessage);
  }
  await expectDecodedThumbnail(acceptedPrompt.locator("img.chat-message-image"));
  await captureUiProof(suite, page, `${proofName}-accepted.png`);
  await gateway.resolveDeferred("chat.startup");
  await expect.poll(() => acceptedPrompt.count()).toBe(1);
  await expectDecodedThumbnail(acceptedPrompt.locator("img.chat-message-image"));
  expect(await gateway.getRequests("sessions.create")).toHaveLength(2);
  expect(await gateway.getRequests("chat.send")).toHaveLength(0);
}

suite.define(() => {
  const openPage = createPageOpener(suite);
  it.each([
    { label: "desktop", viewport: { height: 900, width: 1280 } },
    { label: "mobile", viewport: { height: 844, width: 390 } },
  ])("starts a draft in the background on $label", async ({ label, viewport }) => {
    const proofDir = captureProofEnabled ? transitionProofDir() : undefined;
    const context = await suite.browser.newContext({
      locale: "en-US",
      ...(proofDir ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
      serviceWorkers: "block",
      viewport,
    });
    const page = await context.newPage();
    const video = page.video();
    const sessionKey = `agent:main:dashboard:background-${label}`;
    const runId = `run-background-${label}`;
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.create": {
          key: sessionKey,
          entry: {
            model: "gpt-5.6-sol",
            modelProvider: "openai",
            sessionId: `session-background-${label}`,
            updatedAt: Date.now(),
          },
          runId,
          runStarted: true,
        },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.deferNext("agent.wait");
      const composer = page.locator(".new-session-page__message");
      await composer.fill(`run this separately on ${label}`);
      await captureProof(page, `background-${label}-ready.png`);
      if (captureProofEnabled) {
        await page.waitForTimeout(400);
      }
      await composer.press("Control+Shift+Enter");

      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { agentId: "main", message: `run this separately on ${label}` },
      });
      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      await expectValue(composer, "");
      await captureProof(page, `background-${label}-running.png`);
      await expect
        .poll(() => page.locator(".new-session-page__starting").textContent())
        .toContain(`run this separately on ${label}`);
      await expect
        .poll(() => page.locator(".new-session-page__starting").textContent())
        .toContain("Session created");
      await button(page, "Open session", true).waitFor();
      if (label === "mobile") {
        expect(
          await page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`).count(),
        ).toBe(0);
        await button(page, "Expand sidebar", true).click();
        await waitForMobileSidebarDrawerOpen(page);
      }
      await expect
        .poll(() =>
          page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`).count(),
        )
        .toBe(1);
      if (label === "mobile") {
        expect(
          await page
            .locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`)
            .isVisible(),
        ).toBe(true);
        await page
          .locator(".shell-nav-backdrop")
          .click({ position: { x: viewport.width - 10, y: 100 } });
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .not.toContain("shell--nav-drawer-open");
      }
      if (captureProofEnabled) {
        await page.waitForTimeout(600);
      }

      await expect(gateway.waitForRequest("agent.wait")).resolves.toMatchObject({
        params: { runId, timeoutMs: 30_000 },
      });
      await gateway.resolveDeferred("agent.wait", { endedAt: Date.now(), runId, status: "ok" });
      const toast = page.locator(".app-toast");
      await toast.getByText("Done").waitFor({ timeout: 10_000 });
      await captureProof(page, `background-${label}-complete.png`);
      if (captureProofEnabled) {
        await page.waitForTimeout(800);
      }
      await button(toast, "Open").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionKey));
      await waitForCommittedChatRoute(page);
      await page.locator("openclaw-chat-page").waitFor();
      await captureProof(page, `background-${label}-opened.png`);
      if (captureProofEnabled) {
        await page.waitForTimeout(400);
      }
    } finally {
      await context.close();
      if (proofDir && video) {
        await video.saveAs(path.join(proofDir, `background-${label}.webm`));
        await video.delete();
      }
    }
  });

  it("creates and lists a session with the default mock Gateway", async () => {
    const page = await openPage(createControlUiE2eContextOptions());
    const gateway = await installMockGateway(page);
    await page.goto(`${suite.server.baseUrl}new`);
    const composer = page.locator(".new-session-page__message");
    await composer.fill("verify the default mock");
    const confirmationConsumed = await confirmIme(composer, "");
    expect(confirmationConsumed).toBe(false);
    expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    expect(await composer.inputValue()).toBe("verify the default mock");
    await captureProof(page, "ime-confirmation-retains-draft.png");
    await composer.dispatchEvent("keyup", { key: "Enter" });
    await composer.press("Enter");
    await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
      params: { agentId: "main", message: "verify the default mock" },
    });
    const firstKey = createdKey((await gateway.waitForRequest("sessions.create")).params);
    await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(firstKey));
    await captureProof(page, "ime-deliberate-enter-created.png");
    await page.getByRole("link", { name: "New conversation" }).first().click();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
    await page.locator(".new-session-page__message").fill("verify another default mock");
    await page.locator(".new-session-page__message").press("Control+Enter");
    await waitForRequestCount(gateway, 2, "sessions.create");
    expect((await gateway.getRequests("sessions.create")).at(-1)).toMatchObject({
      params: { agentId: "main", message: "verify another default mock" },
    });
    const secondKey = createdKey(
      (await gateway.waitForRequest("sessions.create", { after: 1 })).params,
    );
    await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(secondKey));
    await expectListedKeys(page, [firstKey, secondKey]);
    await expect.poll(() => page.locator(".new-session-page__error").count()).toBe(0);
    await captureProof(page, "default-mock-created.png");
    const listRequestsBeforeReconnect = (await gateway.getRequests("sessions.list", rosterMatch))
      .length;
    await gateway.closeLatest(1006, "mock reconnect");
    await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(1);
    await expect
      .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
      .toBeGreaterThan(listRequestsBeforeReconnect);
    await expectListedKeys(page, [firstKey, secondKey]);
    await captureProof(page, "default-mock-reconnected.png");
  });

  it("keeps the submitted preview and restores its thinking choice after a rejected edit", async () => {
    const page = await openPage(createControlUiE2eContextOptions());
    const thinkingLevels = ["off", "low", "medium", "high", "xhigh"].map((id) => ({
      id,
      label: id,
    }));
    const entry = {
      sessionId: "created-session",
      modelProvider: "openai",
      model: "gpt-5.6-sol",
      thinkingLevel: "xhigh",
      updatedAt: Date.now(),
    };
    const createdSessionList = createdSessionListResult(SESSION_KEY);
    createdSessionList.sessions = createdSessionList.sessions.map((row) => ({ ...row, ...entry }));
    let releaseChatModule!: () => void;
    let chatModuleRequested = false;
    const chatModuleBlocked = new Promise<void>((resolve) => {
      releaseChatModule = resolve;
    });
    await page.route(
      controlUiE2eBuiltModuleRequest("ui/src/pages/chat/route-entry.ts"),
      async (route) => {
        chatModuleRequested = true;
        await chatModuleBlocked;
        await route.continue();
      },
    );
    const gateway = await installMockGateway(page, {
      subscriptionInitialHistory: false,
      agentModel: "openai/gpt-5.6-sol",
      featureMethods: [
        "agent.wait",
        "chat.metadata",
        "chat.startup",
        "sessions.create",
        "sessions.dispatch",
        "sessions.patch",
      ],
      heldMethods: ["sessions.resolve"],
      models: [
        {
          id: "gpt-5.6-sol",
          name: "GPT-5.6 Sol",
          provider: "openai",
          reasoning: true,
          thinkingDefault: "high",
          thinkingLevels,
        },
      ],
      methodResponses: {
        "agents.list": {
          agents: [{ id: "main", thinkingLevels, thinkingDefault: "high" }],
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
        },
        "sessions.create": {
          key: SESSION_KEY,
          entry,
          messageSeq: 1,
          runId: RUN_ID,
          runStarted: true,
        },
        "sessions.list": { ...createdSessionListResult(SESSION_KEY), count: 0, sessions: [] },
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const effortPicker = page.locator('[data-chat-thinking-select="true"]');
      await effortPicker.click();
      const thinkingSlider = page.locator('[data-chat-thinking-slider="true"]');
      const xhighIndex = await thinkingSlider.evaluate(
        (element) =>
          element.getAttribute("data-chat-thinking-values")?.split(",").indexOf("xhigh") ?? -1,
      );
      expect(xhighIndex).toBeGreaterThanOrEqual(0);
      await thinkingSlider.fill(String(xhighIndex));
      await expectAttribute(effortPicker, "data-chat-thinking-value", "xhigh");
      await page.keyboard.press("Escape");
      const message = page.locator(".new-session-page__message");
      const start = page.locator(".new-session-page__start-submit");
      await message.fill("keep progress moving");
      await expect.poll(() => start.isEnabled()).toBe(true);
      await gateway.waitForRequest("sessions.list", { match: rosterMatch });
      expect(
        await page.locator(`.sidebar-recent-session[data-session-key="${SESSION_KEY}"]`).count(),
      ).toBe(0);
      const listRequestsBeforeSubmit = (await gateway.getRequests("sessions.list", rosterMatch))
        .length;

      await gateway.deferNext("sessions.create");
      await gateway.deferNext("sessions.list", rosterMatch);
      await start.click();
      const create = await gateway.waitForRequest("sessions.create");
      expect(create.params).toMatchObject({ thinkingLevel: "xhigh" });
      const startup = page.locator(".new-session-page__starting");
      const submittedPrompt = startup.locator(".chat-group.user");
      await expect.poll(() => submittedPrompt.isVisible()).toBe(true);
      await pollLocatorText(submittedPrompt).toContain("keep progress moving");
      await pollLocatorText(startup.locator('.chat-working-indicator[role="status"]')).toContain(
        "Starting…",
      );
      await captureProof(page, "00-create-pending.png");
      await expectPendingNewSessionPresentation(page);
      await gateway.resolveDeferred("sessions.create", {
        key: SESSION_KEY,
        entry,
        messageSeq: 1,
        runId: RUN_ID,
        runStarted: true,
      });
      await expect.poll(() => chatModuleRequested).toBe(true);

      expect(new URL(page.url()).pathname).toBe("/new");
      expect(await gateway.getRequests("chat.startup")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.resolve")).toHaveLength(0);
      expect(await submittedPrompt.isVisible()).toBe(true);
      expect(await submittedPrompt.count()).toBe(1);
      await captureProof(page, "01-chat-route-preparing.png");
      await expectPendingNewSessionPresentation(page);

      await evaluateControlUiContext(page, (application) => {
        const frames: SessionTransitionFrames = {
          invalid: 0,
          firstInvalid: null,
          running: true,
          chatSurfaceReady: false,
        };
        Reflect.set(globalThis, "__openclawSessionTransitionFrames", frames);
        const sample = () => {
          const outlet = document.querySelector("openclaw-router-outlet");
          const handoffCover = outlet?.classList.contains("session-route-handoff") === true;
          const newSessionVisible = Boolean(
            document.querySelector(".new-session-page__starting")?.getClientRects().length,
          );
          const composer = document.querySelector(".agent-chat__composer-combobox");
          const chatVisible = Boolean(composer?.getClientRects().length);
          if (
            document.activeViewTransition ||
            handoffCover ||
            (!newSessionVisible && !chatVisible)
          ) {
            frames.invalid += 1;
            const route = application.router.getState().matches[0];
            frames.firstInvalid ??= {
              activeViewTransition: Boolean(document.activeViewTransition),
              handoffCover,
              newSessionVisible,
              chatVisible,
              loadingSkeleton: Boolean(outlet?.querySelector(".loading-skeleton")),
              routeId: route?.routeId,
              routeStatus: route?.status,
              loaderPending: route?.isFetching === "loader",
            };
          }
          // Latch readiness in-frame; the invalid-frame counter covers active transitions too.
          frames.chatSurfaceReady ||= Boolean(composer);
          if (frames.running) {
            requestAnimationFrame(sample);
          }
        };
        requestAnimationFrame(sample);
      });

      await gateway.deferNext("chat.startup");
      releaseChatModule();
      await gateway.waitForRequest("chat.startup");
      await expect
        .poll(() =>
          page.evaluate(() => {
            const frames = Reflect.get(
              globalThis,
              "__openclawSessionTransitionFrames",
            ) as SessionTransitionFrames;
            return frames.chatSurfaceReady;
          }),
        )
        .toBe(true);
      await expect
        .poll(() => page.getByText("keep progress moving", { exact: true }).count())
        .toBe(1);
      const chatEffortPicker = page
        .locator(".agent-chat__input")
        .locator('[data-chat-thinking-select="true"]');
      await expectAttribute(chatEffortPicker, "data-chat-thinking-value", "xhigh");
      await waitForCommittedChatRoute(page);
      expect(new URL(page.url()).pathname).toBe(controlUiSessionPath(SESSION_KEY));
      await waitForRequestCount(
        gateway,
        listRequestsBeforeSubmit + 1,
        "sessions.list",
        rosterMatch,
      );
      expect(await gateway.getRequests("sessions.resolve")).toHaveLength(0);
      const invalidFrames = await page.evaluate(() => {
        const frames = Reflect.get(
          globalThis,
          "__openclawSessionTransitionFrames",
        ) as SessionTransitionFrames;
        frames.running = false;
        return { invalid: frames.invalid, firstInvalid: frames.firstInvalid };
      });
      expect(invalidFrames.invalid, JSON.stringify(invalidFrames.firstInvalid)).toBe(0);
      await captureProof(page, "02-session-route-transition.png");
      await gateway.resolveDeferred("sessions.list", createdSessionList);
      await gateway.resolveDeferred("chat.startup");
      await waitForCommittedChatRoute(page);
      await page.locator("openclaw-chat-page").waitFor();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.activeElement?.matches(".agent-chat__composer-combobox textarea") === true,
          ),
        )
        .toBe(true);
      await expect
        .poll(() => page.getByText("keep progress moving", { exact: true }).count())
        .toBe(1);
      await expectAttribute(chatEffortPicker, "data-chat-thinking-value", "xhigh");
      await captureProof(page, "03-chat-route-ready.png");

      await gateway.deferNext("sessions.patch");
      await chatEffortPicker.click();
      const chatThinkingSlider = page.locator('[data-chat-thinking-slider="true"]');
      const lowIndex = await chatThinkingSlider.evaluate(
        (element) =>
          element.getAttribute("data-chat-thinking-values")?.split(",").indexOf("low") ?? -1,
      );
      expect(lowIndex).toBeGreaterThanOrEqual(0);
      await chatThinkingSlider.fill(String(lowIndex));
      const thinkingPatch = await gateway.waitForRequest("sessions.patch");
      expect(thinkingPatch.params).toMatchObject({ key: SESSION_KEY, thinkingLevel: "low" });
      await expectAttribute(chatEffortPicker, "data-chat-thinking-value", "low");
      await expectValue(chatThinkingSlider, String(lowIndex));
      await captureProof(page, "04-thinking-update-pending.png");

      await gateway.rejectDeferred("sessions.patch", {
        code: "INVALID_REQUEST",
        message: "Synthetic thinking update rejected",
      });
      await expectAttribute(chatEffortPicker, "data-chat-thinking-value", "xhigh");
      await expectValue(chatThinkingSlider, String(xhighIndex));
      await captureProof(page, "05-thinking-update-rejected.png");
      await captureJson(
        "thinking-update.json",
        async () => ({
          createdThinkingLevel: entry.thinkingLevel,
          pendingThinkingLevel: "low",
          rejected: true,
          restoredThinkingLevel: await chatEffortPicker.getAttribute("data-chat-thinking-value"),
          request: thinkingPatch,
        }),
        transitionProofDir(),
      );
    } catch (error) {
      await captureControlUiE2eFailureDiagnostics(page, {
        error: error instanceof Error ? error : new Error(String(error)),
        label: "new-session-selected-effort-transition",
      });
      throw error;
    } finally {
      releaseChatModule();
    }
  });
  // Each width/content pair owns one recovery; the pending view checks both motion modes.
  it.each([
    { mode: "dark", motion: "no-preference", width: 1280, content: "markdown" },
    { mode: "light", motion: "reduce", width: 1280, content: "json" },
    { mode: "dark", motion: "reduce", width: 390, content: "markdown" },
    { mode: "light", motion: "no-preference", width: 390, content: "json" },
  ] satisfies CreateRecoveryCase[])(
    "shows the submitted prompt before creation responds and restores it after failure ($width, $mode, $motion, $content)",
    async (scenario) => {
      await suite.withPage(
        {
          locale: "en-US",
          ...(captureProofEnabled
            ? { recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1280 } } }
            : {}),
          serviceWorkers: "block",
          viewport: { height: 900, width: 1280 },
        },
        ({ page }) => assertCreateRecovery(page, scenario),
      );
    },
  );
});
