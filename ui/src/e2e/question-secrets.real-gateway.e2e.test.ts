import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import type { QuestionRecord } from "@openclaw/gateway-protocol";
import { webkit, type BrowserContextOptions } from "playwright";
import { expect, it, onTestFinished } from "vitest";
import { normalizeSecretsRequestParams } from "../../../src/agents/tools/secrets-tool.ts";
import {
  closeProvider,
  listenProvider,
  writeToolCall,
} from "../../../src/gateway/gateway-provider-fixture.test-support.ts";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.ts";
import { writeOpenAiResponsesText } from "../../../test/helpers/openai-responses-sse.ts";
import type { OpenClawTestInstance } from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { assertServedUi, chatControls, pairFixture } from "./chat-lifecycle.test-support.ts";
import { connectChatGateway, createChatGatewayInstance } from "./chat-real-gateway.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

// Only model output is scripted by default. Tool admission, question normalization,
// Gateway events, access checks, browser submission, and secret-store writes are real.
const live = process.env.OPENCLAW_UI_E2E_LIVE_SECRETS === "1";
const name = "RESEND_API_KEY";
const reason = "Send order confirmations through Resend.";
const args = { action: "request", name, allowedHosts: ["api.resend.com"], reason };
const key = "agent:main:dashboard:credential-proof";
const syntheticSecret = "private-fixture-not-a-working-api-key";
const proof: Record<string, unknown> = {
  model: live ? "OpenAI gpt-4.1-mini" : "deterministic loopback model fixture",
  toolArguments: args,
  websocketInterception: false,
  complete: false,
  source: {
    head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    workingDiffSha256: createHash("sha256")
      .update(execFileSync("git", ["diff", "HEAD"]))
      .digest("hex"),
  },
};
let instance: OpenClawTestInstance;
let client: Awaited<ReturnType<typeof connectChatGateway>>;
let provider: ReturnType<typeof createServer> | undefined;
let calls = 0;
let providerError: unknown;
const suite = createControlUiE2eSuite({
  name: "Credential requests through the real agent and Gateway",
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
    let baseUrl = "https://api.openai.com/v1";
    if (!live) {
      provider = createServer((request, response) => {
        void (async () => {
          const body: { tools?: Array<{ name?: string }>; input?: unknown } = JSON.parse(
            (await buffer(request)).toString("utf8"),
          );
          if (request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          if (calls++ % 2 === 0) {
            expect(body.tools).toContainEqual(expect.objectContaining({ name: "secrets" }));
            writeToolCall(response, "secrets", args);
          } else {
            expect(JSON.stringify(body.input)).not.toContain(syntheticSecret);
            expect(JSON.stringify(body.input)).toContain("stored");
            writeOpenAiResponsesText(response, {
              text: "The credential is saved. No email was sent.",
              messageId: "saved-" + calls,
              responseId: "saved-response-" + calls,
            });
          }
        })().catch((error: unknown) => {
          providerError = error;
          response.writeHead(500).end();
        });
      });
      baseUrl = await listenProvider(provider);
    }
    if (live && !process.env.OPENAI_API_KEY) {
      throw new Error("Live credential proof needs OPENAI_API_KEY");
    }
    instance = await createChatGatewayInstance({
      name: "credential-request",
      provider: "credential-proof",
      identity: "Shop assistant",
      model: live ? "gpt-4.1-mini" : "fixture",
      baseUrl,
      apiKey: live ? process.env.OPENAI_API_KEY! : "synthetic-provider-key",
      models: [
        {
          id: live ? "gpt-4.1-mini" : "fixture",
          name: live ? "GPT-4.1 mini" : "Deterministic credential fixture",
        },
      ],
      entrypoint: ["dist/index.js"],
      config: {
        update: { checkOnStart: false },
        gateway: { controlUi: { enabled: true, root: path.resolve("dist/control-ui") } },
        browser: { enabled: false },
        tools: { allow: ["secrets"], codeMode: false, toolSearch: false },
      },
    });
    ensureGatewayOwnerProfile("Test operator", { env: instance.env });
    try {
      await instance.startGateway();
      return {
        baseUrl: "http://127.0.0.1:" + instance.port + "/",
        close: () =>
          runQaGatewayFixture(
            () => instance.cleanup(),
            async () => {
              if (provider) {
                await closeProvider(provider);
              }
            },
          ),
      };
    } catch (error) {
      await instance.cleanup();
      if (provider) {
        await closeProvider(provider);
      }
      throw error;
    }
  },
});

suite.define(() => {
  it("collects a new credential and a replacement without exposing the value", async () => {
    await client.request("sessions.create", {
      key,
      agentId: "main",
      label: "Connect order emails",
    });
    const browser =
      process.env.OPENCLAW_UI_E2E_SECRETS_BROWSER === "webkit" ? await webkit.launch() : undefined;
    const contextOptions: BrowserContextOptions = {
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      colorScheme: "light",
      ...(browser ? {} : { permissions: ["local-network-access"] }),
      serviceWorkers: "block",
    };
    const context = browser
      ? await browser.newContext(contextOptions)
      : await suite.newBrowserContext(contextOptions);
    if (browser) {
      onTestFinished(async () => {
        await context.close();
        await browser.close();
      });
    }
    const page = await context.newPage();
    try {
      await pairFixture(page, instance);
    } catch (error) {
      await writeFile(
        path.join(suite.artifactDir, "pairing-failure.private.png"),
        await page.screenshot(),
      );
      await writeFile(
        path.join(suite.artifactDir, "pairing-failure.private.txt"),
        (await page.locator("body").textContent()) ?? "",
      );
      throw error;
    }
    await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
    await waitForControlUiGatewayReady(page);
    await assertServedUi(page, suite.server.baseUrl);
    const capture = async (label: string, target = page.locator(".chat-question-panel")) => {
      const text = await page.locator("body").textContent();
      for (const secret of [
        instance.gatewayToken,
        instance.hookToken,
        instance.homeDir,
        syntheticSecret,
        ...(live ? [process.env.OPENAI_API_KEY!] : []),
      ]) {
        expect(text).not.toContain(secret);
      }
      const frame = await takeControlUiScreenshotFrame(
        page,
        target,
        [
          target.locator('input[type="password"]'),
          target.getByRole("button", { name: "Save credential", exact: true }),
        ],
        { animations: "disabled" },
      );
      await writeFile(path.join(suite.artifactDir, label + ".png"), frame.png);
    };
    const questions: unknown[] = [];
    const presentations: Array<{ title: string | null; text: string | null }> = [];
    for (const replacement of [false, true]) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await waitForControlUiGatewayReady(page);
      const { composer, send } = chatControls(page);
      await composer.fill(
        replacement
          ? 'Replace the Resend key I just saved. Request RESEND_API_KEY again, with allowedHosts ["api.resend.com"] and reason "Send order confirmations through Resend." Do not send an email.'
          : 'Help me connect Resend for order confirmation emails. Use secrets request for RESEND_API_KEY, with allowedHosts ["api.resend.com"] and reason "Send order confirmations through Resend." I will enter a private test fixture, not a working key. Do not send an email.',
      );
      await send.click();
      const panel = page.locator(".chat-question-panel:not(.chat-question-panel--collapsed)");
      await panel.locator('input[type="password"]').waitFor({ timeout: 90_000 });
      const pending = await client.request<{ questions: QuestionRecord[] }>("question.list", {});
      const question = pending.questions.find((record) => record.status === "pending")!;
      expect(question).toBeDefined();
      expect(question.questions[0]).toMatchObject(
        normalizeSecretsRequestParams(args).questions[0]!,
      );
      expect(Boolean(question.questions[0]!.secretStoreExisting)).toBe(replacement);
      questions.push(question);
      // Pointer input produces a neutral capture; keyboard focus is exercised separately below.
      await panel.locator(".chat-question-panel__title").click();
      if (!replacement) {
        await capture("desktop-light-new");
        await page.emulateMedia({ colorScheme: "dark" });
        await capture("desktop-dark-new");
      } else {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.goto(new URL("ask/" + question.id, suite.server.baseUrl).href);
        await panel.waitFor();
        await panel.locator(".chat-question-panel__title").click();
        await capture("mobile-dark-replacement");
        await page.emulateMedia({ colorScheme: "light" });
        await capture("mobile-light-replacement");
      }
      presentations.push({
        title: await panel.locator(".chat-question-panel__title").textContent(),
        // oxlint-disable-next-line unicorn/prefer-dom-node-text-content -- Hidden metadata is not part of the visible request hierarchy.
        text: await panel.innerText(),
      });
      const details = panel.getByRole("button", { name: "Credential details", exact: true });
      await details.click();
      await page
        .getByRole("dialog", { name: "Credential details", exact: true })
        .getByText("Saved outside chat. The agent cannot read the value.")
        .waitFor();
      await page.keyboard.press("Escape");
      expect(await details.evaluate((element) => document.activeElement === element)).toBe(true);
      const input = panel.getByLabel("API key", { exact: true });
      expect(
        await input.evaluate(
          (element: HTMLInputElement) => element.labels?.[0]?.getBoundingClientRect().width,
        ),
      ).toBe(1);
      await input.fill(syntheticSecret);
      await input.press("Tab");
      expect(
        await panel
          .getByRole("button", { name: "Show secret", exact: true })
          .evaluate((element) => element.matches(":focus-visible")),
      ).toBe(true);
      await panel.locator(".chat-question-panel__hosts").fill("api.resend.com, events.resend.com");
      await panel.getByRole("button", { name: "Save credential", exact: true }).click();
      await expect
        .poll(async () =>
          (
            await client.request<{ questions: QuestionRecord[] }>("question.list", {})
          ).questions.some((record) => record.id === question.id && record.status === "pending"),
        )
        .toBe(false);
      const store = await client.request("secrets.store.list", {});
      expect(JSON.stringify(store)).toContain("events.resend.com");
      expect(JSON.stringify(store)).not.toContain(syntheticSecret);
      expect(
        await client.request("agent.wait", { runId: question.runId, timeoutMs: 30_000 }),
      ).toMatchObject({ status: "ok" });
      await expect
        .poll(async () =>
          JSON.stringify(
            await client.request("chat.history", { sessionKey: key, limit: 20 }),
          ).includes("stored"),
        )
        .toBe(true);
      expect(
        JSON.stringify(await client.request("chat.history", { sessionKey: key, limit: 20 })),
      ).not.toContain(syntheticSecret);
    }
    for (const presentation of presentations) {
      expect(presentation.title).toBe(name);
      expect(presentation.text).not.toContain(key);
      expect(presentation.text).not.toContain("Provide the secret for");
      expect(presentation.text).toContain(reason);
      expect(presentation.text).toContain("needs a credential");
      expect(presentation.text).not.toContain("Saved outside chat");
    }
    expect(providerError).toBeUndefined();
    proof.questions = questions;
    proof.complete = true;
    await writeFile(path.join(suite.artifactDir, "proof.json"), JSON.stringify(proof, null, 2));
  }, 180_000);
});
