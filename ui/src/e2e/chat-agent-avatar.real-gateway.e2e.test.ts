import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { appendTranscriptMessage } from "../../../src/config/sessions/session-accessor.js";
import { ensureGatewayOwnerProfile, setAvatar } from "../../../src/state/user-profiles.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const captureEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let instance: OpenClawTestInstance | undefined;
const suite = createControlUiE2eSuite({
  name: "Control UI agent avatar with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-agent-avatar",
      config: { gateway: { controlUi: { enabled: true, communityInvite: false } } },
    });
    instance = owner;
    try {
      const config = JSON.parse(await readFile(owner.configPath, "utf8"));
      await owner.state.writeConfig({
        ...config,
        agents: {
          defaults: {
            workspace: owner.state.workspaceDir,
            model: { primary: "openai/gpt-4.1" },
          },
          entries: {
            main: {
              workspace: owner.state.workspaceDir,
              identity: { name: "Avatar Proof", avatar: "agent-avatar.png" },
            },
            emoji: { identity: { name: "Emoji Proof", emoji: "🌙" } },
          },
        },
      });
      const imagePath = path.join(process.cwd(), "ui/public/apple-touch-icon.png");
      await copyFile(imagePath, path.join(owner.state.workspaceDir, "agent-avatar.png"));
      // Seed the browser owner so no host account name or photo enters the capture.
      const profile = ensureGatewayOwnerProfile("Chat Proof", { env: owner.env });
      expect(
        setAvatar(profile.id, await readFile(imagePath), "image/png", { env: owner.env }).ok,
      ).toBe(true);
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      await runQaGatewayFixture(
        async () => {
          throw error;
        },
        () => owner.cleanup(),
      );
      throw error;
    }
  },
});

suite.define(() => {
  it.each([
    { agentId: "main", name: "Avatar Proof", kind: "image" },
    { agentId: "emoji", name: "Emoji Proof", kind: "emoji" },
  ])(
    "keeps the $kind avatar at the start of a persisted assistant reply",
    async ({ agentId, name, kind }) => {
      if (!instance) {
        throw new Error("Gateway fixture is not running");
      }
      const owner = instance;
      const sessionKey = `agent:${agentId}:avatar-proof`;
      const created = await owner.cli([
        "gateway",
        "call",
        "sessions.create",
        "--params",
        JSON.stringify({ key: sessionKey, agentId, label: "Agent avatar proof" }),
        "--json",
      ]);
      expect(created.code, created.stderr).toBe(0);
      const session = JSON.parse(created.stdout) as { ok: boolean; sessionId: string };
      expect(session.ok).toBe(true);
      const reply = [
        "## A clear plan for the next update",
        "I will keep the work in one focused change, starting with the existing behavior.",
        "1. Reproduce the reported layout with a realistic conversation.\n2. Check image and emoji identities using the same message.\n3. Verify that expanding the response does not move its identity marker.",
        "## What stays consistent",
        "The avatar identifies the author of the whole reply, not its final paragraph. It should remain beside the beginning while the content grows below it.",
        "Returning to this conversation should preserve the same alignment.",
        "Avatar layout proof is complete.",
      ].join("\n\n");
      for (const [role, text] of [
        ["user", "Show the configured agent identity in this conversation."],
        ["assistant", reply],
      ]) {
        await appendTranscriptMessage(
          { agentId, sessionKey, sessionId: session.sessionId, env: owner.env },
          { message: { role, content: [{ type: "text", text }], timestamp: Date.now() } },
        );
      }
      const dashboard = await owner.cli(["dashboard", "--json"]);
      const handoff: { browserUrl: string; reason?: string } = JSON.parse(dashboard.stdout);
      expect(dashboard.code, handoff.reason ?? dashboard.stderr).toBe(0);
      const issued = new URL(handoff.browserUrl);
      const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
      url.hash = issued.hash;
      await suite.withPage(
        {
          locale: "en-US",
          colorScheme: "dark",
          viewport: { width: 1440, height: 1000 },
          serviceWorkers: "block",
        },
        async ({ page }) => {
          expect((await page.goto(url.toString()))?.status()).toBe(200);
          await waitForControlUiGatewayReady(page);
          // Inactive panes retain measurable DOM; follow the selected session, not cached replies.
          const pane = page.locator(".chat-pane-cache__pane--active");
          await pane.getByText("Avatar layout proof is complete.", { exact: true }).waitFor();
          const group = pane.locator(".chat-group.assistant");
          const avatar = group.locator(".chat-avatar.assistant:visible");
          if (kind === "image") {
            await expect
              .poll(() => avatar.evaluate((element) => (element as HTMLImageElement).naturalWidth))
              .toBeGreaterThan(0);
            expect(await avatar.getAttribute("src")).toMatch(/^blob:/);
            expect(await avatar.getAttribute("alt")).toBe(name);
          } else {
            expect(await avatar.getAttribute("aria-label")).toBe(name);
            expect(await avatar.locator("[data-avatar]").getAttribute("data-avatar")).toBe("🌙");
          }
          expect(await avatar.isVisible()).toBe(true);
          const readAlignment = async () =>
            group.evaluate((element) => {
              const content = element
                .querySelector(".chat-group-messages")!
                .getBoundingClientRect();
              const visibleAvatar = [...element.querySelectorAll(".chat-avatar.assistant")]
                .find((candidate) => getComputedStyle(candidate).display !== "none")!
                .getBoundingClientRect();
              return { topOffset: visibleAvatar.top - content.top, contentHeight: content.height };
            });
          const alignment = await readAlignment();
          if (captureEnabled) {
            // Capture the real page before asserting, so the broken baseline is retained.
            await page.screenshot({
              path: path.join(suite.artifactDir, `01-${kind}-loaded.png`),
              animations: "disabled",
            });
            await writeFile(
              path.join(suite.artifactDir, "evidence.json"),
              JSON.stringify(
                {
                  sessionKey,
                  kind,
                  assistantAvatarCount: await avatar.count(),
                  alignment,
                  visibleBesidePersistedReply: true,
                  servedScripts: await page
                    .locator("script[src]")
                    .evaluateAll((scripts) =>
                      scripts.map((script) => new URL((script as HTMLScriptElement).src).pathname),
                    ),
                  servedStyles: await page
                    .locator('link[rel="stylesheet"]')
                    .evaluateAll((links) =>
                      links.map((link) => new URL((link as HTMLLinkElement).href).pathname),
                    ),
                },
                null,
                2,
              ),
            );
          }
          expect(alignment.contentHeight).toBeGreaterThan(150);
          expect(Math.abs(alignment.topOffset)).toBeLessThanOrEqual(1);
          const otherSessionKey = `agent:${agentId}:avatar-other`;
          const other = await owner.cli([
            "gateway",
            "call",
            "sessions.create",
            "--params",
            JSON.stringify({ key: otherSessionKey, agentId, label: "Other conversation" }),
            "--json",
          ]);
          expect(other.code, other.stderr).toBe(0);
          await page
            .locator(
              `openclaw-app-sidebar [data-session-key="${otherSessionKey}"] .sidebar-recent-session__link`,
            )
            .click();
          await pane
            .getByText("Avatar layout proof is complete.", { exact: true })
            .waitFor({ state: "hidden" });
          await page
            .locator(
              `openclaw-app-sidebar [data-session-key="${sessionKey}"] .sidebar-recent-session__link`,
            )
            .click();
          await pane.getByText("Avatar layout proof is complete.", { exact: true }).waitFor();
          expect(Math.abs((await readAlignment()).topOffset)).toBeLessThanOrEqual(1);
          await page.reload();
          await waitForControlUiGatewayReady(page);
          await pane.getByText("Avatar layout proof is complete.", { exact: true }).waitFor();
          expect(Math.abs((await readAlignment()).topOffset)).toBeLessThanOrEqual(1);
        },
      );
    },
  );
});
