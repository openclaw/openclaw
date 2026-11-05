import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it } from "vitest";
import { listDirectoryTreeStrict } from "../../../src/infra/directory-walk.js";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import {
  callGateway,
  connectChatGateway,
  createChatGatewayInstance,
  runGatewayCli,
} from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sessionKey = "agent:main:reset-undo-product-proof";
const earlier = "Remember restoration token cedar-417. Acknowledge it.";
const earlierReply = "Saved restoration token cedar-417.";
const later = "This belongs only to the post-reset branch: violet-928.";
const laterReply = "Post-reset branch reply violet-928.";
const restoredReply = "Restored context contains cedar-417 and not violet-928.";
const providerRequests: string[] = [];
const upgradeBaseline = process.env.OPENCLAW_TEST_RESET_UNDO_BASELINE_PREFIX;
const runtimeEntrypoint = [path.resolve("dist/index.js")];
let releasedRuntime: string | undefined;
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
        async () => {
          await instance?.cleanup();
          if (releasedRuntime) {
            await rm(releasedRuntime, { recursive: true, force: true });
          }
        },
        () => provider.releaseListener(),
        () => provider.claim.release(),
      );
    try {
      if (upgradeBaseline) {
        // A released install beneath this checkout still inherits Bun tsconfig aliases.
        // Copy the complete npm prefix outside the source tree, including released dependencies.
        releasedRuntime = await mkdtemp(path.join(tmpdir(), "reset-undo-released-runtime-"));
        await cp(path.resolve(upgradeBaseline), releasedRuntime, { recursive: true });
        runtimeEntrypoint.splice(
          0,
          runtimeEntrypoint.length,
          path.join(releasedRuntime, "node_modules/openclaw/openclaw.mjs"),
        );
      }
      instance = await createChatGatewayInstance({
        name: "reset-undo-product",
        cwd: releasedRuntime,
        entrypoint: runtimeEntrypoint,
        provider: "reset-undo-fixture",
        identity: "Reset Undo assistant",
        model: "echo",
        apiKey: "synthetic-unused-key",
        baseUrl: `http://127.0.0.1:${provider.claim.port}/v1`,
        models: [{ id: "echo", name: "Deterministic reset proof" }],
      });
      if (upgradeBaseline) {
        const initialFiles = await listDirectoryTreeStrict(instance.stateDir);
        expect(
          initialFiles.filter(
            ({ relativePath: name }) =>
              name.endsWith(".sqlite") || name.endsWith(".sqlite3") || name.endsWith(".db"),
          ),
        ).toEqual([]);
        expect(await runGatewayCli(instance, ["--version"])).toContain("2026.11.1");
        await runGatewayCli(instance, [
          "config",
          "set",
          "agents.entries.main.identity.name",
          "Upgrade continuity assistant",
        ]);
        const identityBefore: unknown = JSON.parse(
          await runGatewayCli(instance, [
            "config",
            "get",
            "agents.entries.main.identity.name",
            "--json",
          ]),
        );
        const cronBefore: unknown = JSON.parse(
          await runGatewayCli(instance, ["config", "get", "cron.enabled", "--json"]),
        );
        await instance.startGateway();
        await callGateway(instance, "sessions.create", {
          key: sessionKey,
          agentId: "main",
          label: "Reset Undo product proof",
        });
        const sent: unknown = JSON.parse(
          await callGateway(instance, "chat.send", {
            sessionKey,
            message: earlier,
            idempotencyKey: randomUUID(),
          }),
        );
        assert(isRecord(sent) && typeof sent.runId === "string");
        const settled: unknown = JSON.parse(
          await callGateway(instance, "agent.wait", { runId: sent.runId, timeoutMs: 30_000 }),
        );
        expect(settled).toMatchObject({ status: "ok" });
        const releasedHistory = await callGateway(instance, "chat.history", { sessionKey });
        expect(releasedHistory.includes(earlier)).toBe(true);
        await instance.stopGateway();
        const snapshot = await mkdtemp(
          path.join(process.cwd(), ".openclaw/tmp/reset-upgrade-baseline-"),
        );
        await cp(instance.stateDir, path.join(snapshot, "state"), { recursive: true });
        // Replace only the executable after the released writer drains; retain the same state.
        runtimeEntrypoint.splice(0, runtimeEntrypoint.length, path.resolve("dist/index.js"));
        await instance.startGateway();
        expect(
          JSON.parse(
            await runGatewayCli(instance, [
              "config",
              "get",
              "agents.entries.main.identity.name",
              "--json",
            ]),
          ),
        ).toEqual(identityBefore);
        expect(
          JSON.parse(await runGatewayCli(instance, ["config", "get", "cron.enabled", "--json"])),
        ).toEqual(cronBefore);
        const upgradedHistory = await callGateway(instance, "chat.history", { sessionKey });
        expect(upgradedHistory.includes(earlier)).toBe(true);
        console.log(
          "[reset-undo-upgrade] v2026.11.1 settings and released transcript retained; baseline snapshot:",
          snapshot,
        );
      } else {
        await instance.startGateway();
      }
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
    if (!upgradeBaseline) {
      await client.request("sessions.create", {
        key: sessionKey,
        agentId: "main",
        label: "Reset Undo product proof",
      });
    }
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
        const capture = async (name: string) => {
          if (!upgradeBaseline) {
            await page.screenshot({ path: path.join(suite.artifactDir, name) });
          }
        };
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

        if (!upgradeBaseline) {
          await sendTurn(earlier, earlierReply);
        } else {
          await messages.getByText(earlierReply, { exact: true }).waitFor();
        }
        expect(JSON.stringify((await history()).messages)).toContain(earlier);
        await capture("before-reset.png");
        await client.request("sessions.reset", { key: sessionKey, reason: "reset" });
        const undo = pane.getByRole("button", { name: "Undo", exact: true });
        await undo.waitFor();
        await expect.poll(() => messages.getByText(earlierReply, { exact: true }).count()).toBe(0);
        await sendTurn(later, laterReply);
        const resetBranch = (await branches()).branches.find((branch) => branch.active);
        expect(resetBranch).toBeDefined();
        await capture("after-reset.png");

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
        await capture("undo-after-reload.png");

        await sendTurn("What restoration token did I give before the reset?", restoredReply);
        expect(providerRequests).toHaveLength(3);
        expect(providerRequests[2]?.includes(earlier), "restored pre-reset model context").toBe(
          true,
        );
        expect(providerRequests[2]?.includes(later), "excluded post-reset model context").toBe(
          false,
        );
        await capture("restored-next-turn.png");

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
