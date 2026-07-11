import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const available = canRunPlaywrightChromium(executablePath);
const allowMissing = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const suite = available || !allowMissing ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

suite("Claude native session catalog", () => {
  beforeAll(async () => {
    if (!available) {
      throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("uses native sidebar/chat pagination and disables paired-node continuation", async () => {
    const page = await browser.newPage();
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "claude",
              label: "Claude Code",
              capabilities: { continueSession: true, archive: false },
              hosts: [
                {
                  hostId: "node:devbox",
                  label: "Dev Box",
                  kind: "node",
                  connected: true,
                  nodeId: "devbox",
                  sessions: [
                    {
                      threadId: "remote-thread",
                      name: "Remote architecture review",
                      status: "stored",
                      source: "claude-cli",
                      archived: false,
                      canContinue: false,
                      canArchive: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
        "sessions.catalog.read": {
          cases: [
            {
              match: { cursor: "older" },
              response: {
                hostId: "node:devbox",
                threadId: "remote-thread",
                items: [{ id: "u1", type: "userMessage", text: "older question" }],
              },
            },
            {
              match: {},
              response: {
                hostId: "node:devbox",
                threadId: "remote-thread",
                items: [{ id: "a1", type: "agentMessage", text: "newer answer" }],
                nextCursor: "older",
              },
            },
          ],
        },
      },
    });
    await page.goto(`${server.baseUrl}chat`);
    await page.getByText("Remote architecture review", { exact: true }).click();
    await expect.poll(() => page.getByText("newer answer", { exact: true }).count()).toBe(1);
    await page.getByRole("button", { name: "Load older" }).click();
    await expect.poll(() => page.getByText("older question", { exact: true }).count()).toBe(1);
    expect(await page.locator(".agent-chat__composer-combobox > textarea").isDisabled()).toBe(true);
    await expect
      .poll(() => page.getByText("This session is on a paired node and is view-only.").count())
      .toBe(1);
    expect((await gateway.getRequests("sessions.catalog.read")).at(-1)?.params).toMatchObject({
      catalogId: "claude",
      cursor: "older",
    });
    await page.close();
  });
});
