import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import * as tar from "tar";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let instance: OpenClawTestInstance | undefined;
const suite = createControlUiE2eSuite({
  name: "Template upload with a real built Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    // CI's prebuilt setup binds stamps to clean source and verifies the asset generation.
    // Explicit entrypoint prevents a missing build from falling back to source preparation.
    for (const file of [
      "dist/index.js",
      "dist/.buildstamp",
      "dist/.runtime-postbuildstamp",
      "dist/control-ui/.build-inputs.json",
    ]) {
      expect((await readFile(file)).length, file).toBeGreaterThan(0);
    }
    // Installation now starts the agent’s greeting. Keep that real Gateway path,
    // but script only its loopback model response; this is not external-provider proof.
    const provider = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          request.resume();
          request.once("end", () => {
            if (request.method !== "POST" || request.url !== "/v1/responses") {
              response.writeHead(404).end();
              return;
            }
            writeOpenAiResponsesText(response, {
              text: "Synthetic upload greeting.",
              messageId: "upload-proof-message",
              responseId: "upload-proof-response",
            });
          });
        }),
    });
    const cleanup = () =>
      runQaGatewayFixture(
        async () => {
          await instance?.cleanup();
        },
        async () => {
          provider.listener.closeAllConnections();
          await provider.releaseListener();
        },
        () => provider.claim.release(),
      );
    try {
      const owner = await createChatGatewayInstance({
        name: "template-upload",
        provider: "template-upload-fixture",
        identity: "Upload fixture",
        model: "echo",
        apiKey: "synthetic-unused-key",
        baseUrl: `http://127.0.0.1:${provider.claim.port}/v1`,
        models: [{ id: "echo", name: "Echo" }],
        entrypoint: ["dist/index.js"],
        config: {
          gateway: {
            controlUi: {
              enabled: true,
              root: path.resolve("dist/control-ui"),
              experimental: { templates: true },
            },
            reload: { mode: "hybrid" },
          },
          plugins: { allow: [] },
          cron: { enabled: false },
          logging: { level: "info", consoleLevel: "error" },
        },
      });
      instance = owner;
      const validation = await owner.cli(["config", "validate", "--json"]);
      expect(validation.code, validation.stdout || validation.stderr).toBe(0);
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: cleanup };
    } catch (error) {
      return await runQaGatewayFixture(async (): Promise<never> => {
        throw error;
      }, cleanup);
    }
  },
});

suite.define(() => {
  it("uploads an actual archive, reviews, and installs persisted agent files", async () => {
    const owner = instance!;
    const source = path.join(owner.stateDir, "synthetic-upload");
    await mkdir(source, { recursive: true });
    await writeFile(
      path.join(source, "package.json"),
      JSON.stringify({
        name: "@proof/upload-proof",
        version: "0.1.0",
        openclaw: { template: "CLAW.md" },
      }),
    );
    await writeFile(
      path.join(source, "CLAW.md"),
      "---\nschemaVersion: 1\nagent:\n  id: upload-proof\n  name: Upload Proof\n---\nSynthetic upload proof.\n",
    );
    await writeFile(path.join(source, "SOUL.md"), "Synthetic upload proof instructions.\n");
    const archive = path.join(owner.stateDir, "upload-proof.tgz");
    await tar.c({ gzip: true, cwd: source, file: archive }, ["package.json", "CLAW.md", "SOUL.md"]);
    let dashboard = await owner.cli(["dashboard", "--json"]);
    await expect
      .poll(
        async () => {
          if (dashboard.code !== 0) {
            dashboard = await owner.cli(["dashboard", "--json"]);
          }
          return dashboard.code;
        },
        { timeout: 45_000, message: owner.logs() },
      )
      .toBe(0);
    const handoff = JSON.parse(dashboard.stdout);
    const url = new URL("templates", handoff.browserUrl);
    url.hash = new URL(handoff.browserUrl).hash;
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      // Network review/install completion is not the renderer's one-second polling budget.
      // Observe the real browser RPC; never call the owner directly or extend a timeout.
      const receipts = {
        "templates.add.plan": Promise.withResolvers<boolean>(),
        "templates.add.apply": Promise.withResolvers<boolean>(),
      };
      const requests = new Map<string, keyof typeof receipts>();
      page.on("websocket", (socket) => {
        socket.on("framesent", ({ payload }) => {
          const frame = asOptionalRecord(JSON.parse(payload.toString()));
          if (
            frame?.type === "req" &&
            typeof frame.id === "string" &&
            (frame.method === "templates.add.plan" || frame.method === "templates.add.apply")
          ) {
            requests.set(frame.id, frame.method);
          }
        });
        socket.on("framereceived", ({ payload }) => {
          const frame = asOptionalRecord(JSON.parse(payload.toString()));
          const method =
            frame?.type === "res" && typeof frame.id === "string"
              ? requests.get(frame.id)
              : undefined;
          if (method) {
            receipts[method].resolve(frame?.ok === true);
          }
        });
      });
      expect((await page.goto(url.toString()))?.status()).toBe(200);
      await waitForControlUiGatewayReady(page);
      const importButton = page.getByRole("button", { name: "Import", exact: true });
      await importButton.waitFor();
      const entry = await page
        .locator('script[type="module"][src*="/assets/index-"]')
        .getAttribute("src");
      expect(entry).toBeTruthy();
      const asset = new URL(entry!, page.url());
      const served = await page.request.get(asset.toString(), {
        headers: { "Accept-Encoding": "identity" },
      });
      expect(served.status()).toBe(200);
      expect(digest(await served.body())).toBe(
        digest(await readFile(path.join("dist/control-ui", asset.pathname.replace(/^\//u, "")))),
      );

      const capture = async (name: string, content: import("playwright").Locator) => {
        const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [content], {
          animations: "disabled",
          viewport: { width: 1280, height: 900 },
        });
        await writeFile(path.join(suite.artifactDir, name), frame.png);
      };
      const picker = page.waitForEvent("filechooser");
      await importButton.click();
      await (await picker).setFiles(archive);
      expect(await receipts["templates.add.plan"].promise).toBe(true);
      await page.getByRole("dialog", { name: "Import Template" }).waitFor();
      const dialog = page.getByRole("dialog", { name: "Import Template" });
      await expect
        .poll(() => dialog.getByRole("heading", { name: "Upload Proof" }).isVisible())
        .toBe(true);
      expect(await dialog.locator(".oc-dialog__header").count()).toBe(0);
      const confirm = dialog.getByRole("button", { name: "Import", exact: true });
      await expect.poll(() => confirm.isVisible()).toBe(true);
      await capture("review.png", confirm);
      await confirm.click();
      expect(await receipts["templates.add.apply"].promise).toBe(true);
      const success = page.getByText("Installed agent: upload-proof", { exact: true });
      await expect.poll(() => success.isVisible()).toBe(true);
      await capture("installed.png", success);
      const config = JSON.parse(await readFile(owner.configPath, "utf8"));
      const agent = config.agents.entries["upload-proof"];
      expect(agent).toBeTruthy();
      expect((await stat(agent.workspace)).isDirectory()).toBe(true);
      // The manifest’s Markdown body owns SOUL.md, not undeclared archive files.
      expect(await readFile(path.join(agent.workspace, "SOUL.md"), "utf8")).toBe(
        "Synthetic upload proof.\n",
      );
    });
  });
});
