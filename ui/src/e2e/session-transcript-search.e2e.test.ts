import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionPath,
  installMockGateway,
  type MockGatewayWindow,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { waitForSessionText as waitText } from "./session-ui.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session transcript search",
  trackBrowserContexts: true,
});
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const timestamp = Date.parse("2026-07-12T14:30:00.000Z");
const searchScope = {
  agentId: "main",
  excludeDock: true,
  includeGlobal: true,
  includeUnknown: false,
  configuredAgentsOnly: true,
};
let page: Page | undefined;

async function newPage(height = 800, width = 1200, proof = false, light = false) {
  const context = await suite.newBrowserContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height, width },
    ...(light ? { colorScheme: "light" as const } : {}),
    ...(proof && captureProof
      ? { recordVideo: { dir: suite.artifactDir, size: { height, width } } }
      : {}),
  });
  return (page = await context.newPage());
}

function sessionRow(name: string, label?: string, updatedAt = timestamp) {
  return { key: `agent:main:${name}`, kind: "direct", label, updatedAt };
}

function listResponse(sessions: unknown[], model: string | null = null) {
  return {
    count: sessions.length,
    defaults: { contextTokens: null, model, modelProvider: model ? "openai" : null },
    path: "",
    sessions,
    ts: timestamp,
  };
}

function searchHit(session: string, snippet: string, role = "assistant", score = 1) {
  return {
    messageId: `message-${session}`,
    role,
    score,
    sessionId: `session-${session}`,
    sessionKey: `agent:main:${session}`,
    snippet,
    timestamp,
  };
}

async function openSearch(browserPage: Page) {
  await browserPage.goto(`${suite.server.baseUrl}sessions`);
  const search = browserPage.getByRole("search", { name: "Search transcripts" });
  await search.getByRole("button", { name: "Search transcripts" }).click();
  return { search, input: search.getByRole("searchbox", { name: "Search session transcripts" }) };
}

async function captureUiProof(fileName: string) {
  if (!captureProof || !page) {
    return;
  }
  if (page.video()) {
    await writeFile(
      path.join(suite.artifactDir, fileName),
      await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
        page.locator("#control-ui-main"),
      ]),
    );
    return;
  }
  await page.screenshot({ fullPage: true, path: path.join(suite.artifactDir, fileName) });
}

async function resolveDeferredAndDrain(
  browserPage: Page,
  method: string,
  payload: unknown,
): Promise<void> {
  await browserPage.evaluate(
    async ({ targetMethod, responsePayload }) => {
      const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway;
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

suite.define(() => {
  it("searches once on submit, shows provenance, and opens the matching chat", async () => {
    page = await newPage(900, 1440, true, true);
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
        "sessions.list": listResponse(
          [
            {
              ...sessionRow("launch", "Launch planning"),
              displayName: "Launch planning",
              status: "done",
              totalTokens: 1200,
            },
          ],
          "gpt-5.5",
        ),
        "sessions.search": {
          results: [
            searchHit(
              "launch",
              "The nebula launch checklist is ready for final review.",
              "assistant",
              3.4,
            ),
          ],
        },
      },
      sessionKey: "agent:main:main",
    });

    const { search, input } = await openSearch(page);
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
      scope: searchScope,
    });
    for (const text of ["Launch planning", "Assistant", "nebula launch checklist"]) {
      await expect.poll(() => result.textContent()).toContain(text);
    }
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
    page = await newPage(1000, 1440, true);
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.search"],
      sessionArchiveFiltering: true,
      methodResponses: {
        "sessions.list": listResponse([
          sessionRow("active", "Active task"),
          { ...sessionRow("archived", "Archived task"), archived: true },
        ]),
        "sessions.search": {
          results: [searchHit("active", "Release notes from the active task.")],
        },
      },
    });
    const { input } = await openSearch(page);
    await input.fill("Release notes");
    await input.press("Enter");
    await waitText(page, "Release notes from the active task.");
    expect((await gateway.getRequests("sessions.search"))[0]?.params).toMatchObject({
      scope: {
        agentId: "main",
        includeGlobal: true,
        includeUnknown: false,
        configuredAgentsOnly: true,
      },
    });

    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page
      .locator(
        '.sessions-filter-popover:popover-open .sessions-view-segment input[value="archived"]',
      )
      .click();
    await expect.poll(() => new URL(page!.url()).searchParams.get("status")).toBe("archived");
    await waitText(page.locator(".session-data-row"), "Archived task");
    await captureUiProof("filter-scope.png");
    expect(await page.locator(".sessions-transcript-search__result").count()).toBe(0);
    expect(await input.inputValue()).toBe("Release notes");
    // Keep the active hit in the fixture: the Gateway must exclude it from the archived scope.
    await input.press("Enter");
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(2);
    expect((await gateway.getRequests("sessions.search"))[1]?.params).toMatchObject({
      scope: { agentId: "main", archived: true },
    });
    await waitText(page, "No transcript messages match that search.");
    expect(await page.locator(".sessions-transcript-search__result").count()).toBe(0);
  });

  it("finds an older off-roster transcript without enumerating session pages", async () => {
    const first = sessionRow("first");
    const missed = sessionRow("missed", "Earlier launch planning", timestamp - 86_400_000);
    page = await newPage();
    const gateway = await installMockGateway(page, {
      sessions: [first, missed],
      methodResponses: {
        "sessions.list": {
          ...listResponse([first]),
          hasMore: true,
          nextOffset: 1,
          offset: 0,
          totalCount: 2,
        },
        "sessions.search": {
          sessions: [missed],
          results: [{ ...searchHit("missed", "the recovered launch code"), sessionId: "missed" }],
        },
      },
    });

    const { input } = await openSearch(page);
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
    await waitText(match, "the recovered launch code");
    expect(await match.textContent()).toContain("Earlier launch planning");
    expect(await gateway.getRequests("sessions.search")).toHaveLength(1);
    expect((await gateway.getRequests("sessions.search"))[0]?.params).toEqual({
      limit: 25,
      query: "launch code",
      scope: searchScope,
    });
    expect(await gateway.getRequests("sessions.list")).toEqual(listRequests);
  });

  it("ignores stale results and exposes indexing and request errors", async () => {
    page = await newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.search"],
      methodResponses: {
        "sessions.list": listResponse([
          { ...sessionRow("stale", "Stale search fixture"), status: "done", totalTokens: 0 },
        ]),
        "sessions.search": { indexing: true, results: [] },
      },
    });

    const { search, input } = await openSearch(page);
    const submit = search.getByRole("button", { name: "Search transcripts" });
    const empty = page.getByText("No transcript messages match that search.", { exact: true });
    const indexing = page.getByText(
      "The transcript index is still updating. Retry to include recent messages.",
    );
    const retry = page.getByRole("button", { name: "Retry" });
    await input.waitFor({ state: "visible", timeout: 10_000 });
    await input.fill("   ");
    await expect.poll(() => submit.isEnabled()).toBe(true);
    await input.press("Enter");
    expect(await gateway.getRequests("sessions.search")).toHaveLength(0);

    await gateway.deferNext("sessions.search");
    await input.fill("old phrase");
    await expect.poll(() => submit.isEnabled()).toBe(true);
    await input.press("Enter");
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(1);
    await input.fill("new phrase");
    await resolveDeferredAndDrain(page, "sessions.search", {
      results: [searchHit("stale", "stale result must stay hidden", "user")],
    });
    expect(await page.getByText("stale result must stay hidden", { exact: true }).count()).toBe(0);
    await input.press("Enter");
    await indexing.waitFor({ state: "visible", timeout: 10_000 });
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(2);
    expect(await page.getByText("No transcript messages match that search.").count()).toBe(0);

    await gateway.setMethodResponse("sessions.search", { results: [] });
    await retry.click();
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(3);
    await empty.waitFor({ state: "visible", timeout: 10_000 });
    expect(await indexing.count()).toBe(0);

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
    await retry.click();
    await expect.poll(async () => gateway.getRequests("sessions.search")).toHaveLength(5);
    await empty.waitFor({ state: "visible" });
    expect(await page.getByText(/Transcript search failed:/).count()).toBe(0);
  });
});
