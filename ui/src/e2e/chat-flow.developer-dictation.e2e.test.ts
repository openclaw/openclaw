import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it, onTestFinished } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installTalkBrowserFixtures } from "./browser-talk-start-stop.fixtures.ts";
import {
  captureUiProofEnabled,
  createChatFlowE2eSuite,
  installMockGateway,
  newChatPage,
} from "./chat-flow.test-support.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";

// Real built UI/editor behavior; Gateway responses and microphone audio are synthetic.
const suite = createChatFlowE2eSuite();
const sessionId = "developer-syntax-browser";

async function openDictationPage() {
  const page = await newChatPage(suite, {
    locale: "en-US",
    serviceWorkers: "block",
    permissions: ["microphone"],
    viewport: { width: 1440, height: 1200 },
  });
  const gateway = await installMockGateway(page, {
    methodResponses: {
      "talk.catalog": {
        transcription: { ready: true, providers: [] },
        realtime: { ready: false, providers: [] },
        speech: { providers: [] },
        modes: [],
        transports: [],
        brains: [],
      },
      "talk.session.create": {
        sessionId,
        transcriptionSessionId: sessionId,
        audio: { inputEncoding: "g711_ulaw", inputSampleRateHz: 8000 },
      },
    },
  });
  await installTalkBrowserFixtures(page);
  return { page, gateway, textarea: page.locator(".agent-chat__composer-combobox textarea") };
}

async function setSyntaxSettingsOpen(page: Page, open = true) {
  await page.getByRole("button", { name: "Add attachment", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Dictation syntax", exact: true }).click();
  await page
    .getByRole("checkbox", { name: "Enable exact syntax review", exact: true })
    .waitFor({ state: open ? "visible" : "hidden" });
}

async function enableSyntaxReview(page: Page) {
  await setSyntaxSettingsOpen(page);
  await page
    .getByRole("combobox", { name: "Spoken command language", exact: true })
    .selectOption("en-US");
  await page
    .getByRole("combobox", { name: "Dictation mode", exact: true })
    .selectOption("developer");
  await page.getByRole("checkbox", { name: "Enable exact syntax review", exact: true }).check();
}

async function finalizeCapture(
  page: Page,
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  textarea: Locator,
  draft: string,
) {
  await page.getByRole("button", { name: "Start voice input", exact: true }).hover();
  await page.mouse.down();
  await gateway.waitForRequest("talk.session.create");
  await page.mouse.up();
  const spoken = "snake case customer account ID end identifier";
  await gateway.emitGatewayEvent("talk.event", {
    transcriptionSessionId: sessionId,
    type: "partial",
    text: spoken,
  });
  expect(await textarea.inputValue()).toBe(draft);
  await page.getByRole("button", { name: "Stop and keep text", exact: true }).click();
  await gateway.waitForRequest("talk.session.close");
  await gateway.emitGatewayEvent("talk.event", {
    transcriptionSessionId: sessionId,
    type: "transcript",
    text: spoken,
    final: true,
  });
  await gateway.emitGatewayEvent("talk.event", {
    transcriptionSessionId: sessionId,
    type: "close",
    reason: "completed",
  });
  const preview = page.getByRole("textbox", { name: "Exact preview", exact: true });
  await preview.waitFor();
  expect(await preview.inputValue()).toBe("customer_account_id");
  expect(
    await page.getByRole("textbox", { name: "Recognized original", exact: true }).inputValue(),
  ).toBe(spoken);
  expect(await textarea.inputValue()).toBe(draft);
  return preview;
}

async function capture(page: Page, name: string, content: Locator[]) {
  if (!captureUiProofEnabled) {
    return;
  }
  const surface = page.locator(".agent-chat__composer-shell");
  const frame = await takeControlUiScreenshotFrame(page, surface, content, {
    elements: [surface],
    animations: "disabled",
  });
  await writeFile(path.join(suite.artifactDir, `${name}.png`), frame.png);
  await writeFile(path.join(suite.artifactDir, `${name}-composer.png`), frame.elements[0]!.png);
}

suite.define(() => {
  it("loads syntax processing and review copy only after opening syntax settings", async () => {
    const { page, textarea } = await openDictationPage();
    const modules = [
      controlUiE2eBuiltModuleRequest("ui/src/pages/chat/composer-developer-syntax.ts"),
      controlUiE2eBuiltModuleRequest("src/shared/dictation-developer.ts"),
      controlUiE2eBuiltModuleRequest("ui/src/i18n/locales/en-chat-dictation.ts"),
      controlUiE2eBuiltModuleRequest("ui/src/pages/chat/components/developer-syntax-panel.tsx"),
    ];
    const requests: string[] = [];
    page.on("request", (request) => requests.push(new URL(request.url()).pathname));
    const phaseRequests: { disabled?: string[] } = {};
    onTestFinished(async () => {
      if (captureUiProofEnabled) {
        await writeFile(
          path.join(suite.artifactDir, "syntax-module-requests.json"),
          JSON.stringify({ ...phaseRequests, requests }, null, 2),
        );
      }
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await textarea.waitFor();
    phaseRequests.disabled = [...requests];
    expect(requests.filter((request) => modules.some((module) => module.test(request)))).toEqual(
      [],
    );
    await capture(page, "disabled", [textarea]);

    await setSyntaxSettingsOpen(page);
    for (const module of modules) {
      expect(requests.some((request) => module.test(request))).toBe(true);
    }
  });

  it("reviews a finalized capture, inserts exact unsent text and supports native undo", async () => {
    const { page, gateway, textarea } = await openDictationPage();
    await page.goto(`${suite.server.baseUrl}chat`);
    await textarea.waitFor();
    await enableSyntaxReview(page);
    await capture(page, "settings", [textarea]);
    await setSyntaxSettingsOpen(page, false);
    await textarea.fill("prefix: ");
    const preview = await finalizeCapture(page, gateway, textarea, "prefix: ");
    await capture(page, "review", [textarea, preview]);
    await page.getByRole("button", { name: "Insert into draft", exact: true }).click();
    await expect.poll(() => textarea.inputValue()).toBe("prefix: customer_account_id");
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    await capture(page, "inserted-unsent", [textarea]);
    await textarea.focus();
    await textarea.press("ControlOrMeta+z");
    await expect.poll(() => textarea.inputValue()).toBe("prefix: ");
    expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    await capture(page, "native-undo", [textarea]);
  });

  it("declines required capture while syntax runtime loads, then retries exact review", async () => {
    const { page, gateway, textarea } = await openDictationPage();
    await page.goto(`${suite.server.baseUrl}chat`);
    await textarea.waitFor();
    await enableSyntaxReview(page);
    const runtime = controlUiE2eBuiltModuleRequest(
      "ui/src/pages/chat/composer-developer-syntax.ts",
    );
    const release = Promise.withResolvers<void>();
    let held = false;
    await page.route(runtime, async (route) => {
      held = true;
      await release.promise;
      await route.continue();
    });
    try {
      await page.reload();
      await textarea.waitFor();
      await expect.poll(() => held).toBe(true);
      await textarea.fill("retained draft");
      await page.getByRole("button", { name: "Start voice input", exact: true }).hover();
      const holding = page.locator(".chat-talk-control--holding").filter({
        has: page.getByRole("button", { name: "Start voice input", exact: true }),
      });
      await page.mouse.down();
      await holding.waitFor();
      await holding.waitFor({ state: "detached" });
      await page.mouse.up();
      expect(await gateway.getRequests("talk.session.create")).toHaveLength(0);
      expect(
        await page.evaluate(
          () =>
            (window as Window & { openclawTalkE2eState?: { constraints: unknown[] } })
              .openclawTalkE2eState?.constraints,
        ),
      ).toEqual([]);
      expect(await textarea.inputValue()).toBe("retained draft");
      await capture(page, "runtime-pending", [textarea]);
      release.resolve();
      await setSyntaxSettingsOpen(page);
      await setSyntaxSettingsOpen(page, false);
      const preview = await finalizeCapture(page, gateway, textarea, "retained draft");
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await capture(page, "runtime-retry-review", [textarea, preview]);
    } finally {
      release.resolve();
      await page.unroute(runtime);
    }
  });
});
