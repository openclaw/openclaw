import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { TEST_LINK_READER } from "../test-helpers/link-reader.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { pullPreviewResponse } from "./github-link-hovercard.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Session GitHub previews",
  trackBrowserContexts: true,
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});
suite.define(() => {
  it("reads a configured Enterprise card in the current chat session", async () => {
    const context = await suite.newBrowserContext({
      colorScheme: "light",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 800, width: 1180 },
    });
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
        },
      ],
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    const link = page.getByRole("link", { name: "private change", exact: true });
    await link.hover();
    const card = page.locator(".link-reader-hovercard");
    await card.waitFor({ state: "visible" });
    await expect.poll(() => card.textContent()).toContain("Repair private project preview");
    const startup = await gateway.waitForRequest("chat.startup");
    const sessionKey = "agent:main:main";
    expect(startup.params).toMatchObject({ sessionKey });
    expect((await gateway.getRequests("forge.preview")).map(({ params }) => params)).toEqual([
      expect.objectContaining({ url, sessionKey }),
    ]);
    expect(await card.locator(".link-reader-hovercard__author").getAttribute("href")).toBe(
      "https://code.example.com/reader",
    );
  });
});
