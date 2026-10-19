import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { pullPreviewResponse } from "./github-link-hovercard.test-support.ts";

let artifactDir: string | undefined;
beforeEach(() => {
  const parent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
  artifactDir = parent
    ? createControlUiE2eArtifactDir("session-github-preview", parent)
    : undefined;
});
const suite = createControlUiE2eSuite({
  name: "Session GitHub previews",
  trackBrowserContexts: true,
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
async function newBrowserContext() {
  return suite.newBrowserContext({
    colorScheme: "light",
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 800, width: 1180 },
  });
}
async function captureArtifact(page: Page, name: string) {
  if (artifactDir) {
    await page.screenshot({ path: path.join(artifactDir, `${name}.png`) });
  }
}
async function expectText(locator: Locator, text: string) {
  await expect.poll(() => locator.textContent()).toContain(text);
}
suite.define(() => {
  it("reads a configured Enterprise card in the current chat session", async () => {
    const context = await newBrowserContext();
    const page = await context.newPage();
    const url = "https://code.example.com/example/project/pull/7";
    const gateway = await installMockGateway(page, {
      controlUiLinkReaders: [
        {
          ...TEST_LINK_READER,
          id: "session-items",
          linkReader: {
            ...TEST_LINK_READER.linkReader,
            hosts: ["code.example.com"],
            sessionScoped: true,
          },
        },
      ],
      featureMethods: [...defaultControlUiFeatureMethods, "forge.preview", "forge.detail"],
      methodResponses: {
        "forge.preview": {
          cases: [
            {
              match: { url },
              response: {
                ...pullPreviewResponse,
                url,
                title: "Repair private project preview",
                subtitle: "example/project #7",
                authorUrl: "https://code.example.com/reader",
              },
            },
          ],
        },
      },
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: `Review [private change](${url}).` }],
          timestamp: Date.now(),
        },
      ],
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const link = page.getByRole("link", { name: "private change", exact: true });
    await link.waitFor({ state: "visible" });
    await captureArtifact(page, "enterprise-before-hover");
    await link.hover();
    const card = page.locator(".link-reader-hovercard");
    await card.waitFor({ state: "visible" });
    await expectText(card, "Repair private project preview");
    const startup = await gateway.waitForRequest("chat.startup");
    const sessionKey = isRecord(startup.params) ? startup.params.sessionKey : undefined;
    expect(sessionKey).toBe("agent:main:main");
    expect((await gateway.getRequests("forge.preview")).map(({ params }) => params)).toEqual([
      expect.objectContaining({ url, sessionKey }),
    ]);
    expect(await card.locator(".link-reader-hovercard__author").getAttribute("href")).toBe(
      "https://code.example.com/reader",
    );
    await captureArtifact(page, "enterprise-after-hover");
  });
});
