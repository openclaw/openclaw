// Control UI E2E tests transcript search through the scoped Gateway method.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { beforeEach, afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  canRunPlaywrightChromium,
  controlUiSessionPath,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let artifactDir: string;
beforeEach(() => {
  if (captureProof) {
    artifactDir = createControlUiE2eArtifactDir("session-transcript-search");
  }
});

// Browser contexts preserve test isolation; keep one process warm for this file.
let browser: Browser;
let context: BrowserContext | undefined;
let page: Page | undefined;
let server: ControlUiE2eServer | undefined;

async function captureUiProof(fileName: string) {
  if (!captureProof || !page) {
    return;
  }
  if (page.video()) {
    await writeFile(
      path.join(artifactDir, fileName),
      await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
        page.locator("#control-ui-main"),
      ]),
    );
    return;
  }
  await page.screenshot({ fullPage: true, path: path.join(artifactDir, fileName) });
}

async function resolveDeferredAndDrain(
  browserPage: Page,
  method: string,
  payload: unknown,
): Promise<void> {
  await browserPage.evaluate(
    async ({ targetMethod, responsePayload }) => {
      const gateway = (
        window as Window & {
          openclawControlUiE2eGateway?: {
            resolveDeferred: (method: string, payload?: unknown) => void;
          };
        }
      ).openclawControlUiE2eGateway;
      if (!gateway) {
        throw new Error("Mock Gateway is not installed");
      }
      gateway.resolveDeferred(targetMethod, responsePayload);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    },
    { targetMethod: method, responsePayload: payload },
  );
}

describeControlUiE2e("Control UI session transcript search", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close();
      throw error;
    }
  });

  afterEach(async () => {
    await context?.close().catch(() => {});
    context = undefined;
    page = undefined;
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await server?.close();
  });

  it("searches once on submit, shows provenance, and opens the matching chat", async () => {
    const timestamp = Date.parse("2026-07-12T14:30:00.000Z");
    context = await browser.newContext({
      colorScheme: "light",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
      ...(captureProof
        ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1440 } } }
        : {}),
    });
    page = await context.newPage();
    const gateway = await installMockGateway(page, {
      // Core search remains usable even when omitted from the feature catalog.
      featureMethods: ["chat.metadata", "chat.startup"],
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "The nebula launch checklist is ready." }],
          timestamp,
        },
      ],
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
          path: "",
          sessions: [
            {
              displayName: "Launch planning",
              key: "agent:main:launch",
              kind: "direct",
              label: "Launch planning",
              status: "done",
              totalTokens: 1200,
              updatedAt: timestamp,
            },
          ],
          ts: timestamp,
        },
        "sessions.search": {
          results: [
            {
              messageId: "message-launch",
              role: "assistant",
              score: 3.4,
              sessionId: "session-launch",
              sessionKey: "agent:main:launch",
              snippet: "The nebula launch checklist is ready for final review.",
              timestamp,
            },
          ],
        },
      },
      sessionKey: "agent:main:main",
    });

    await page.goto(`${server?.baseUrl ?? ""}sessions`);
    const search = page.getByRole("search", { name: "Search transcripts" });
    const input = search.getByRole("searchbox", { name: "Search session transcripts" });
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await captureUiProof("01-initial.png");

    await input.fill("  nebula launch  ");
    await captureUiProof("02-query.png");
    expect(await gateway.getRequests("sessions.search")).toHaveLength(0);

    await input.press("Enter");
    const result = page.locator(".sessions-transcript-search__result");
    await result.waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(1);
    expect((await gateway.getRequests("sessions.search"))[0]?.params).toEqual({
      limit: 25,
      query: "nebula launch",
      scope: {
        agentId: "main",
        includeGlobal: true,
        includeUnknown: false,
        configuredAgentsOnly: true,
      },
    });
    await expect.poll(() => result.textContent()).toContain("Launch planning");
    await expect.poll(() => result.textContent()).toContain("Assistant");
    await expect.poll(() => result.textContent()).toContain("nebula launch checklist");
    await captureUiProof("03-results.png");

    await search.getByRole("button", { name: "Clear" }).click();
    await expect.poll(() => input.inputValue()).toBe("");
    await expect.poll(() => result.count()).toBe(0);
    expect(await gateway.getRequests("sessions.search")).toHaveLength(1);

    await input.fill("nebula launch");
    await input.press("Enter");
    await result.waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(2);
    await result.click();
    await expect
      .poll(() => (page ? new URL(page.url()).pathname : ""))
      .toBe(controlUiSessionPath("agent:main:launch"));
    await page
      .getByText("The nebula launch checklist is ready.", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    await captureUiProof("04-matching-chat.png");
  });

  it("clears transcript matches when switching from active to archived sessions", async () => {
    const timestamp = Date.parse("2026-08-26T12:00:00.000Z");
    context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
      ...(captureProof
        ? { recordVideo: { dir: artifactDir, size: { height: 1000, width: 1440 } } }
        : {}),
    });
    page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.search"],
      sessionArchiveFiltering: true,
      methodResponses: {
        "sessions.list": {
          count: 2,
          defaults: { contextTokens: null, model: null, modelProvider: null },
          path: "",
          sessions: [
            {
              key: "agent:main:active",
              label: "Active task",
              kind: "direct",
              updatedAt: timestamp,
            },
            {
              key: "agent:main:archived",
              label: "Archived task",
              kind: "direct",
              archived: true,
              updatedAt: timestamp,
            },
          ],
          ts: timestamp,
        },
        "sessions.search": {
          results: [
            {
              messageId: "message-active",
              role: "assistant",
              score: 1,
              sessionId: "session-active",
              sessionKey: "agent:main:active",
              snippet: "Release notes from the active task.",
              timestamp,
            },
          ],
        },
      },
    });
    await page.goto(`${server?.baseUrl ?? ""}sessions`);
    const search = page.getByRole("search", { name: "Search transcripts" });
    const input = search.getByRole("searchbox", { name: "Search session transcripts" });
    await input.fill("Release notes");
    await input.press("Enter");
    await page.getByText("Release notes from the active task.", { exact: true }).waitFor();
    expect((await gateway.getRequests("sessions.search"))[0]?.params).toMatchObject({
      scope: {
        agentId: "main",
        includeGlobal: true,
        includeUnknown: false,
        configuredAgentsOnly: true,
      },
    });

    await page.locator('.sessions-view-segment wa-radio[value="archived"]').click();
    await expect.poll(() => new URL(page!.url()).searchParams.get("status")).toBe("archived");
    await page.locator(".session-data-row").getByText("Archived task", { exact: true }).waitFor();
    await captureUiProof("filter-scope.png");
    expect(await page.locator(".sessions-transcript-search__result").count()).toBe(0);
    expect(await input.inputValue()).toBe("Release notes");
    // Keep the active hit in the fixture: the Gateway must exclude it from the archived scope.
    await input.press("Enter");
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(2);
    expect((await gateway.getRequests("sessions.search"))[1]?.params).toMatchObject({
      scope: { agentId: "main", archived: true },
    });
    await page
      .getByText("No transcript messages match that search.", { exact: true })
      .waitFor({ state: "visible" });
    expect(await page.locator(".sessions-transcript-search__result").count()).toBe(0);
  });

  it("finds an older off-roster transcript without enumerating session pages", async () => {
    const timestamp = Date.parse("2026-07-12T14:30:00.000Z");
    const first = { key: "agent:main:first", kind: "direct", updatedAt: timestamp };
    const missed = {
      key: "agent:main:missed",
      label: "Earlier launch planning",
      kind: "direct",
      updatedAt: timestamp - 86_400_000,
    };
    context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 800, width: 1200 },
    });
    page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessions: [first, missed],
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: { contextTokens: null, model: null, modelProvider: null },
          hasMore: true,
          nextOffset: 1,
          offset: 0,
          path: "",
          sessions: [first],
          totalCount: 2,
          ts: timestamp,
        },
        "sessions.search": {
          sessions: [missed],
          results: [
            {
              messageId: "message-missed",
              role: "assistant",
              score: 1,
              sessionId: "missed",
              sessionKey: missed.key,
              snippet: "the recovered launch code",
              timestamp,
            },
          ],
        },
      },
    });

    await page.goto(`${server?.baseUrl ?? ""}sessions`);
    const input = page.getByRole("searchbox", { name: "Search session transcripts" });
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await page
      .getByRole("checkbox", { name: `Select session: ${first.key}`, exact: true })
      .waitFor();
    expect(
      await page
        .getByRole("checkbox", { name: `Select session: ${missed.key}`, exact: true })
        .count(),
    ).toBe(0);
    const listRequests = await gateway.getRequests("sessions.list");
    await input.fill("launch code");
    await input.press("Enter");

    const match = page.locator(".sessions-transcript-search__result");
    await match.getByText("the recovered launch code", { exact: true }).waitFor();
    expect(await match.textContent()).toContain("Earlier launch planning");
    expect(await gateway.getRequests("sessions.search")).toHaveLength(1);
    expect((await gateway.getRequests("sessions.search"))[0]?.params).toEqual({
      limit: 25,
      query: "launch code",
      scope: {
        agentId: "main",
        includeGlobal: true,
        includeUnknown: false,
        configuredAgentsOnly: true,
      },
    });
    expect(await gateway.getRequests("sessions.list")).toEqual(listRequests);
  });

  it("ignores stale results and exposes indexing and request errors", async () => {
    const timestamp = Date.parse("2026-07-12T14:30:00.000Z");
    context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 800, width: 1200 },
    });
    page = await context.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.search"],
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: { contextTokens: null, model: null, modelProvider: null },
          path: "",
          sessions: [
            {
              key: "agent:main:stale",
              kind: "direct",
              label: "Stale search fixture",
              status: "done",
              totalTokens: 0,
              updatedAt: timestamp,
            },
          ],
          ts: timestamp,
        },
        "sessions.search": { indexing: true, results: [] },
      },
    });

    await page.goto(`${server?.baseUrl ?? ""}sessions`);
    const search = page.getByRole("search", { name: "Search transcripts" });
    const input = search.getByRole("searchbox", { name: "Search session transcripts" });
    const submit = search.getByRole("button", { name: "Search" });
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await input.fill("   ");
    await expect.poll(() => submit.isDisabled()).toBe(true);
    await input.press("Enter");
    expect(await gateway.getRequests("sessions.search")).toHaveLength(0);

    await gateway.deferNext("sessions.search");
    await input.fill("old phrase");
    await expect.poll(() => submit.isEnabled()).toBe(true);
    await input.press("Enter");
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(1);
    await input.fill("new phrase");
    await resolveDeferredAndDrain(page, "sessions.search", {
      results: [
        {
          messageId: "message-stale",
          role: "user",
          score: 1,
          sessionId: "session-stale",
          sessionKey: "agent:main:stale",
          snippet: "stale result must stay hidden",
          timestamp,
        },
      ],
    });
    expect(await page.getByText("stale result must stay hidden", { exact: true }).count()).toBe(0);
    await input.press("Enter");
    await page
      .getByText("The transcript index is still updating. Retry to include recent messages.")
      .waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(2);
    expect(await page.getByText("No transcript messages match that search.").count()).toBe(0);

    await gateway.setMethodResponse("sessions.search", { results: [] });
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(3);
    await page
      .getByText("No transcript messages match that search.", { exact: true })
      .waitFor({ state: "visible", timeout: 10_000 });
    expect(
      await page
        .getByText("The transcript index is still updating. Retry to include recent messages.")
        .count(),
    ).toBe(0);

    await gateway.deferNext("sessions.search");
    await submit.click();
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(4);
    await gateway.rejectDeferred("sessions.search", {
      code: "UNAVAILABLE",
      message: "Search service unavailable",
      retryable: true,
    });
    await page
      .getByText(/Transcript search failed:.*Search service unavailable/)
      .waitFor({ state: "visible", timeout: 10_000 });
    await captureUiProof("05-search-request-error.png");
    await page.getByRole("button", { name: "Retry" }).click();
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(5);
    await page
      .getByText("No transcript messages match that search.", { exact: true })
      .waitFor({ state: "visible" });
    expect(await page.getByText(/Transcript search failed:/).count()).toBe(0);
  });
});
