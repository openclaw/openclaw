import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import type { SessionsListResult } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import { connectChatGateway, createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:avatar-revision-proof";
// Valid decodable PNG: production avatar delivery runs createImageProcessor().encode.
const dataAvatar = `data:image/png;base64,${createSolidPngBuffer(2, 2, {
  r: 34,
  g: 197,
  b: 94,
}).toString("base64")}`;

type AvatarNetworkProof = {
  url: string;
  status: number | null;
};

let instance: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>>;
const suite = createControlUiE2eSuite({
  name: "Session agent avatar revision with a real Gateway",
  startServerBeforeBrowser: true,
  resources: {
    async run(signal) {
      client = await connectChatGateway(instance, signal);
    },
    async close() {
      await client?.stopAndWait();
    },
  },
  async startServer() {
    instance = await createChatGatewayInstance({
      name: "session-avatar-revision",
      provider: "avatar-fixture",
      identity: "Avatar Revision Proof",
      model: "unused",
      api: "openai-completions",
      apiKey: "synthetic-unused-key",
      baseUrl: "http://127.0.0.1:9/v1",
      models: [{ id: "unused", name: "Unused" }],
      // Spreading agents replaces createChatGatewayInstance defaults; keep model defaults.
      agents: {
        defaults: {
          model: "avatar-fixture/unused",
          modelPolicy: { allow: ["avatar-fixture/*"] },
        },
        ownership: "explicit",
        entries: {
          main: {
            identity: { name: "Avatar Revision Proof", avatar: dataAvatar },
          },
        },
      },
    });
    try {
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close: () => instance.cleanup() };
    } catch (error) {
      await instance.cleanup();
      throw error;
    }
  },
});

async function openSession(page: Page) {
  if (!instance) {
    throw new Error("Gateway fixture is not running");
  }
  const dashboard = await instance.cli(["dashboard", "--json"]);
  const handoff: { browserUrl: string; reason?: string } = JSON.parse(dashboard.stdout);
  expect(dashboard.code, handoff.reason ?? dashboard.stderr).toBe(0);
  const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  url.hash = new URL(handoff.browserUrl).hash;
  expect((await page.goto(url.toString()))?.status()).toBe(404);
  await enterControlUiSession(page);
  await waitForControlUiGatewayReady(page);
}

suite.define(() => {
  it("projects a revisioned session owner avatarUrl and loads it in the browser", async () => {
    // sessions.create is a closed object without owner; assign after create.
    await client.request("sessions.create", {
      key: sessionKey,
      agentId: "main",
      label: "Avatar revision proof",
    });
    await client.request("sessions.assignOwner", {
      key: sessionKey,
      agentId: "main",
      owner: { type: "agent", id: "main" },
    });

    const listed = await client.request<SessionsListResult>("sessions.list", {
      agentId: "main",
      limit: 50,
    });
    const row = listed.sessions.find((entry) => entry.key === sessionKey);
    expect(row, JSON.stringify(listed.sessions.map((entry) => entry.key))).toBeTruthy();
    const ownerAvatar = row?.owner?.actor?.avatarUrl;
    expect(ownerAvatar, JSON.stringify(row?.owner)).toMatch(
      /^\/(?:control\/)?avatar\/main\?v=[a-f0-9]+$/,
    );

    const artifactDir = createControlUiE2eArtifactDir("session-avatar-revision");
    const network: AvatarNetworkProof[] = [];
    await suite.withPage(
      { locale: "en-US", viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        page.on("response", (response) => {
          const url = response.url();
          if (new URL(url).pathname.includes("/avatar/main")) {
            network.push({ url, status: response.status() });
          }
        });
        await openSession(page);
        // Agent owner chip in the session header/sidebar uses the projected avatarUrl
        // and/or the agent-list contract; either path must request a revisioned route.
        const chip = page.locator("openclaw-session-owner-chip, .session-owner-chip").first();
        await chip.waitFor({ state: "visible", timeout: 30_000 });
        await expect
          .poll(
            () =>
              network.filter((entry) => /[?&]v=[a-f0-9]+/.test(new URL(entry.url).search)).length,
            { timeout: 30_000 },
          )
          .toBeGreaterThan(0);
        const revisioned = network.filter((entry) =>
          /[?&]v=[a-f0-9]+/.test(new URL(entry.url).search),
        );
        expect(revisioned.every((entry) => entry.status === 200 || entry.status === 304)).toBe(
          true,
        );
        const screenshot = await page.screenshot({ fullPage: false });
        const { writeFile } = await import("node:fs/promises");
        const path = await import("node:path");
        await writeFile(path.join(artifactDir, "session-owner-avatar-after.png"), screenshot);
        await writeFile(
          path.join(artifactDir, "session-owner-avatar-network.json"),
          JSON.stringify({ ownerAvatar, network }, null, 2),
        );
        console.info(
          JSON.stringify({
            proof: "session-avatar-revision",
            ownerAvatar,
            network,
            artifactDir,
          }),
        );
      },
    );
  });
});
