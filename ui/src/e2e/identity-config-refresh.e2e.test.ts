import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import type { AgentsListResult } from "../api/types.ts";
import type { ControlUiMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
  requireRecord,
  requireString,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();
const initialName = "Atlas";
const nextName = "Cedar";
const initialAvatar = "🦞";
const nextAvatar = "🌻";
const draft = "Keep this unsent garden note.";
const reply = "The garden note stayed in this chat.";
const identity = (name: string, avatar: string) => ({
  agentId: "main",
  name,
  avatar,
  avatarStatus: "none",
  nameSource: "agent",
});
const roster = (name: string, avatar: string): AgentsListResult => ({
  defaultId: "main",
  mainKey: "main",
  scope: "per-sender",
  agents: [
    { id: "main", name, identity: { name, emoji: avatar }, model: { primary: "openai/gpt-5.5" } },
  ],
});

suite.define(() => {
  it("refreshes the visible chat identity after a successful config change", async () => {
    const context = await suite.newBrowserContext({
      ...createControlUiE2eContextOptions(),
      locale: "en-US",
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    const screenshots: string[] = [];
    const capture = async (name: string) => {
      const file = path.join(suite.artifactDir, name);
      await page.screenshot({ path: file });
      screenshots.push(file);
    };
    try {
      const gateway = await installMockGateway(page, {
        assistantName: initialName,
        historyMessages: [],
        communityInvite: false,
        methodResponses: {
          "agent.identity.get": identity(initialName, initialAvatar),
          "agents.list": roster(initialName, initialAvatar),
        },
      });
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "main"));
      const heading = page.locator(".agent-chat__welcome-identity h2");
      const avatar = page.locator(".agent-chat__welcome-identity .agent-chat__avatar--text");
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await expect.poll(() => heading.textContent()).toBe(initialName);
      await expect.poll(async () => (await avatar.textContent())?.trim()).toBe(initialAvatar);
      await expect.poll(() => composer.getAttribute("placeholder")).toContain(initialName);
      await composer.fill(draft);
      const sessionUrl = page.url();
      expect(await page.locator(".chat-group").count()).toBe(0);
      await capture("initial.png");

      const successfulResponses = await page.evaluateHandle(
        ({ nextIdentity, nextRoster }) => {
          const fixture = (
            window as Window & {
              openclawControlUiE2eGateway?: ControlUiMockGateway;
            }
          ).openclawControlUiE2eGateway;
          if (!fixture) {
            throw new Error("Mock Gateway is not installed");
          }
          const rows: Array<{ method: string; params: unknown; response: unknown }> = [];
          for (const [method, response] of [
            ["agent.identity.get", nextIdentity],
            ["agents.list", nextRoster],
          ] as const) {
            fixture.setRequestHandler(method, ({ params, respond }) => {
              respond(response);
              rows.push({ method, params, response });
            });
          }
          return rows;
        },
        { nextIdentity: identity(nextName, nextAvatar), nextRoster: roster(nextName, nextAvatar) },
      );
      try {
        await gateway.emitGatewayEvent("config.changed", { hash: "synthetic-identity-change" });
        await expect
          .poll(() =>
            successfulResponses.evaluate(
              (rows) => rows.filter((row) => row.method === "agents.list").length,
            ),
          )
          .toBeGreaterThanOrEqual(1);
        await expect
          .poll(() =>
            successfulResponses.evaluate(
              (rows) => rows.filter((row) => row.method === "agent.identity.get").length,
            ),
          )
          .toBeGreaterThanOrEqual(2);
        await expect.poll(() => page.title()).toContain(nextName);
        const observed = {
          name: (await heading.textContent())?.trim(),
          avatar: (await avatar.textContent())?.trim(),
          avatarLabel: await avatar.getAttribute("aria-label"),
          placeholder: await composer.getAttribute("placeholder"),
        };
        expect([initialName, nextName]).toContain(observed.name);
        expect([initialAvatar, nextAvatar]).toContain(observed.avatar);
        expect(await composer.inputValue()).toBe(draft);
        expect(page.url()).toBe(sessionUrl);
        expect(await page.locator(".chat-group").count()).toBe(0);
        expect((await gateway.getRequests("chat.send")).length).toBe(0);
        await capture("settled.png");

        await page.getByRole("button", { name: "Send message" }).click();
        const request = await gateway.waitForRequest("chat.send");
        const params = requireRecord(request.params);
        expect(params.sessionKey).toBe("agent:main:main");
        expect(params.message).toBe(draft);
        const runId = requireString(params.idempotencyKey, "chat run id");
        await gateway.emitChatFinal({ runId, text: reply });
        await page.locator(".chat-group.assistant .chat-text", { hasText: reply }).waitFor();
        const sender = (
          await page.locator(".chat-group.assistant .chat-sender-name").first().textContent()
        )?.trim();
        expect(page.url()).toBe(sessionUrl);
        expect((await gateway.getRequests("chat.send")).length).toBe(1);
        await capture("roundtrip.png");
        const responses = await successfulResponses.jsonValue();
        await writeFile(
          path.join(suite.artifactDir, "receipts.json"),
          JSON.stringify(
            {
              initial: {
                name: initialName,
                avatar: initialAvatar,
                sessionUrl,
                draft,
                transcriptRows: 0,
              },
              observed,
              sender,
              responses,
              screenshots,
              controls: {
                sessionPreserved: true,
                draftPreserved: true,
                transcriptPreserved: true,
                sendsBeforeSubmit: 0,
                sendsAfterSubmit: 1,
                sentSession: params.sessionKey,
                sentMessage: params.message,
                reply,
                replyVisible: true,
              },
            },
            null,
            2,
          ),
        );
        expect(
          { ...observed, sender },
          "config identity display follows committed identity",
        ).toEqual({
          name: nextName,
          avatar: nextAvatar,
          avatarLabel: nextName,
          placeholder: "Message Cedar",
          sender: nextName,
        });
      } finally {
        await successfulResponses.dispose();
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
