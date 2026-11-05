import { createServer } from "node:http";
import path from "node:path";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { connectChatGateway, createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:reset-undo-product-proof";
const earlier = "Remember restoration token cedar-417. Acknowledge it.";
const earlierReply = "Saved restoration token cedar-417.";
const later = "This belongs only to the post-reset branch: violet-928.";
const laterReply = "Post-reset branch reply violet-928.";
const restoredReply = "Restored context contains cedar-417 and not violet-928.";
const providerRequests: string[] = [];
type Branch = { leafEntryId: string; active: boolean };
let instance: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>>;
const suite = createControlUiE2eSuite({
  name: "Reset Undo through the real UI and isolated Gateway",
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
    // Only the inference endpoint is deterministic. Browser, agent execution,
    // reset marker production, transcript storage, and rewind use product code.
    const provider = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          const chunks: Buffer[] = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.once("end", () => {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            const body = Buffer.concat(chunks).toString("utf8");
            providerRequests.push(body);
            const turn = providerRequests.length;
            writeOpenAiResponsesText(response, {
              text: turn === 1 ? earlierReply : turn === 2 ? laterReply : restoredReply,
              messageId: `reset-undo-message-${turn}`,
              responseId: `reset-undo-response-${turn}`,
            });
          });
        }),
    });
    const cleanup = () =>
      runQaGatewayFixture(
        () => instance?.cleanup(),
        () => provider.releaseListener(),
        () => provider.claim.release(),
      );
    try {
      instance = await createChatGatewayInstance({
        name: "reset-undo-product",
        entrypoint: ["dist/index.js"],
        provider: "reset-undo-fixture",
        identity: "Reset Undo assistant",
        model: "echo",
        apiKey: "synthetic-unused-key",
        baseUrl: `http://127.0.0.1:${provider.claim.port}/v1`,
        models: [{ id: "echo", name: "Deterministic reset proof" }],
      });
      await instance.startGateway();
      return { baseUrl: `http://127.0.0.1:${instance.port}/`, close: cleanup };
    } catch (error) {
      return runQaGatewayFixture(async () => {
        throw error;
      }, cleanup);
    }
  },
});

suite.define(() => {
  it("undoes a real reset, persists restored history, preserves the other branch, and sends restored context to the next agent turn", async () => {
    await client.request("sessions.create", {
      key: sessionKey,
      agentId: "main",
      label: "Reset Undo product proof",
    });
    await suite.withPage(
      { viewport: { width: 1440, height: 1000 }, colorScheme: "light" },
      async ({ page }) => {
        const url = controlUiSessionUrl(suite.server.baseUrl, sessionKey);
        await pairFixture(page, instance);
        await page.goto(url);
        await waitForControlUiGatewayReady(page);
        await assertServedUi(page, suite.server.baseUrl);
        const { pane, composer, send, stop } = chatControls(page);
        const messages = pane.locator(".chat-text");
        const sendTurn = async (prompt: string, answer: string) => {
          await composer.fill(prompt);
          await send.click();
          await messages.getByText(answer, { exact: true }).waitFor();
          await expect.poll(() => stop.isVisible()).toBe(false);
        };
        const history = () =>
          client.request<{ messages: unknown[] }>("chat.history", { sessionKey });
        const branches = () =>
          client.request<{ branches: Branch[] }>("sessions.branches.list", { sessionKey });

        await sendTurn(earlier, earlierReply);
        expect(JSON.stringify((await history()).messages)).toContain(earlier);
        await page.screenshot({ path: path.join(suite.artifactDir, "before-reset.png") });
        await client.request("sessions.reset", { key: sessionKey, reason: "reset" });
        const undo = pane.getByRole("button", { name: "Undo", exact: true });
        await undo.waitFor();
        await expect.poll(() => messages.getByText(earlierReply, { exact: true }).count()).toBe(0);
        await sendTurn(later, laterReply);
        const resetBranch = (await branches()).branches.find((branch) => branch.active);
        expect(resetBranch).toBeDefined();
        await page.screenshot({ path: path.join(suite.artifactDir, "after-reset.png") });

        await undo.click();
        const dialog = page.getByRole("dialog", { name: "Undo session reset?" });
        await dialog.waitFor();
        await dialog.getByRole("button", { name: "Undo reset", exact: true }).click();
        await messages.getByText(earlierReply, { exact: true }).waitFor();
        await expect.poll(() => messages.getByText(laterReply, { exact: true }).count()).toBe(0);
        expect(JSON.stringify((await history()).messages)).toContain(earlier);
        expect(JSON.stringify((await history()).messages)).not.toContain(later);

        await page.reload();
        await waitForControlUiGatewayReady(page);
        await messages.getByText(earlierReply, { exact: true }).waitFor();
        await expect.poll(() => messages.getByText(laterReply, { exact: true }).count()).toBe(0);
        await page.screenshot({ path: path.join(suite.artifactDir, "undo-after-reload.png") });

        await sendTurn("What restoration token did I give before the reset?", restoredReply);
        expect(providerRequests).toHaveLength(3);
        expect(providerRequests[2]?.includes(earlier), "restored pre-reset model context").toBe(
          true,
        );
        expect(providerRequests[2]?.includes(later), "excluded post-reset model context").toBe(
          false,
        );
        await page.screenshot({ path: path.join(suite.artifactDir, "restored-next-turn.png") });

        const restoredBranch = (await branches()).branches.find((branch) => branch.active);
        expect(restoredBranch).toBeDefined();
        expect((await branches()).branches).toContainEqual(
          expect.objectContaining({ leafEntryId: resetBranch!.leafEntryId, active: false }),
        );
        await client.request("sessions.branches.switch", {
          sessionKey,
          leafEntryId: resetBranch!.leafEntryId,
        });
        expect(JSON.stringify((await history()).messages)).toContain(later);
        await client.request("sessions.branches.switch", {
          sessionKey,
          leafEntryId: restoredBranch!.leafEntryId,
        });
        expect(JSON.stringify((await history()).messages)).toContain(earlier);
        expect(JSON.stringify((await history()).messages)).not.toContain(later);
      },
    );
  });
});
