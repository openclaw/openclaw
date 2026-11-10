// Real session/worktree admission, media authorization, image decoding, and downloads.
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { appendTranscriptMessage } from "../../../src/config/sessions/session-accessor.js";
import { saveMediaBuffer } from "../../../src/media/store.js";
import { setAvatar } from "../../../src/state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile } from "../../../src/state/user-profiles.js";
import { withEnvAsync } from "../../../src/test-utils/env.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { readControlUiE2eDownload } from "../test-helpers/control-ui-e2e-download.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { controlUiSessionUrl } from "../test-helpers/control-ui-e2e.ts";
import { enterControlUiSession } from "../test-helpers/control-ui-session-entry.ts";
import { connectChatGateway } from "./chat-real-gateway.test-support.ts";
import { createLocalNetworkControlUiContextOptions } from "./control-ui-browser-options.test-support.ts";
import { createControlUiE2eSuite, tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";

const execFileAsync = promisify(execFile);
let instance: OpenClawTestInstance | undefined;
let client: Awaited<ReturnType<typeof connectChatGateway>> | undefined;
const suite = createControlUiE2eSuite({
  name: "Control UI project media with a real Gateway",
  startServerBeforeBrowser: true,
  resources: {
    async run(signal) {
      if (!instance) {
        throw new Error("Gateway fixture is not running");
      }
      client = await connectChatGateway(instance, signal);
    },
    async close() {
      await client?.stopAndWait();
    },
  },
  async startServer() {
    const owner = await createOpenClawTestInstance({
      name: "control-ui-project-media",
      config: {
        gateway: { controlUi: { enabled: true } },
        agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
      },
    });
    instance = owner;
    try {
      // The first browser connection otherwise adopts the host account's name and photo.
      const profile = ensureGatewayOwnerProfile("Image Proof", { env: owner.env });
      const avatar = await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
      expect(setAvatar(profile.id, avatar, "image/png", { env: owner.env }).ok).toBe(true);
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
  it("renders project media, enforces image access, and preserves inbound download names", async () => {
    if (!instance) {
      throw new Error("Gateway fixture is not running");
    }
    const owner = instance;
    const gateway = client;
    if (!gateway) {
      throw new Error("Gateway fixture client is not connected");
    }
    const projectRoot = owner.state.path("project");
    await mkdir(projectRoot, { recursive: true });
    await writeFile(path.join(projectRoot, "README.md"), "# Synthetic image preview project\n");
    const git = (...args: string[]) =>
      execFileAsync("git", args, {
        cwd: projectRoot,
        env: owner.env,
      });
    await git("init", "--initial-branch=main");
    await git("add", "README.md");
    await git("config", "user.name", "Proof");
    await git("config", "user.email", "proof@example.invalid");
    await git("commit", "-m", "init");
    const project = await gateway.request("projects.register", {
      path: projectRoot,
      name: "Image proof",
    });
    const sessionKey = "agent:main:project-media-proof";
    const session = await gateway.request("sessions.create", {
      key: sessionKey,
      agentId: "main",
      projectId: project.id,
      worktree: true,
      worktreeBaseRef: "main",
      worktreeName: "image-preview-proof",
      permissionMode: "workspace",
      label: "Synthetic image preview proof",
    });
    expect(session.ok).toBe(true);
    const worktree = session.worktree as { path: string };
    expect(typeof worktree.path).toBe("string");
    expect(worktree.path).not.toBe(projectRoot);
    const projectImage = path.join(worktree.path, ".openclaw", "tmp", "proof", "project.png");
    const outsideImage = owner.state.path("outside", "selected.png");
    const siblingImage = owner.state.path("outside", "unselected.png");
    const images = [projectImage, outsideImage, siblingImage];
    for (const target of images) {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"), target);
    }
    const append = <Message>(message: Message) =>
      appendTranscriptMessage(
        { agentId: "main", sessionKey, sessionId: String(session.sessionId), env: owner.env },
        { message },
      );
    const introduction = "Synthetic project image preview.";
    const imageText = [introduction, ...images.map((image) => `MEDIA:${image}`)].join("\n\n");
    await append({
      role: "assistant",
      content: [{ type: "text", text: imageText }],
      timestamp: Date.now(),
    });
    const dashboard = await owner.cli(["dashboard", "--json"]);
    expect(dashboard.code, dashboard.stderr).toBe(0);
    const issued = new URL((JSON.parse(dashboard.stdout) as { browserUrl: string }).browserUrl);
    const url = new URL(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
    url.hash = issued.hash;
    await suite.withPage(createLocalNetworkControlUiContextOptions(), async ({ page }) => {
      const cards = page.locator(".chat-assistant-attachment-card");
      const allow = (root: Page | Locator = page) =>
        root.getByRole("button", { name: "Allow image", exact: true });
      const decoded = async (image: Locator) =>
        (await image.count()) === 1
          ? image.evaluate((element) =>
              element instanceof HTMLImageElement && element.complete ? element.naturalWidth : 0,
            )
          : 0;
      expect((await page.goto(url.toString()))?.status()).toBe(404);
      await enterControlUiSession(page);
      await waitForControlUiGatewayReady(page);
      await page.getByText(introduction, { exact: true }).waitFor();
      const projectPreview = page.locator('img.chat-message-image[src*="project.png"]');
      await expect.poll(() => decoded(projectPreview)).toBeGreaterThan(0);
      const selected = cards.filter({ has: page.getByText("selected.png", { exact: true }) });
      const other = cards.filter({ hasText: "unselected.png" });
      await expect.poll(() => allow().count()).toBe(2);
      const selectedTitle = selected.locator(".chat-assistant-attachment-card__title");
      await selectedTitle.hover();
      await expect.poll(() => tooltipTitleText(selectedTitle)).toContain(outsideImage);
      await page
        .locator("openclaw-tooltip .tooltip-content")
        .filter({ hasText: outsideImage })
        .waitFor({ state: "visible" });
      await allow(selected).click();
      const allowedPreview = page.locator(
        'img.chat-message-image[src*="selected.png"]:not([src*="unselected.png"])',
      );
      await expect.poll(() => decoded(allowedPreview)).toBeGreaterThan(0);
      expect(await allow(other).count()).toBe(1);

      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const permissionTrigger = pane.locator('[data-chat-permission-select="true"]');
      const selectPermission = async (mode: "full" | "workspace") => {
        await permissionTrigger.click();
        await pane.locator(`[data-chat-permission-option="${mode}"]`).click();
        await expect
          .poll(() => permissionTrigger.getAttribute("data-chat-select-value"))
          .toBe(mode);
        await expect.poll(() => permissionTrigger.isEnabled()).toBe(true);
      };
      await selectPermission("full");
      for (const filename of ["project.png", "selected.png", "unselected.png"]) {
        await expect
          .poll(() => decoded(page.locator(`img.chat-message-image[src*="%2F${filename}"]`)))
          .toBeGreaterThan(0);
      }
      expect(await allow().count()).toBe(0);

      await selectPermission("workspace");
      await expect.poll(() => decoded(projectPreview)).toBeGreaterThan(0);
      await expect.poll(() => allow().count()).toBe(2);

      const filename = "café 雪 🦞.txt";
      const bytes = Buffer.from("café|雪|🦞\r\n139+241=380\r\n");
      const saved = await withEnvAsync({ OPENCLAW_STATE_DIR: owner.env.OPENCLAW_STATE_DIR }, () =>
        saveMediaBuffer(bytes, "text/plain", "inbound", undefined, filename),
      );
      await append({
        role: "user",
        timestamp: Date.now(),
        content: "Synthetic original-filename download proof.",
        __openclaw: {
          media: [
            {
              url: `media://inbound/${saved.id}`,
              contentType: "text/plain",
              kind: "document",
              fileName: filename,
              sizeBytes: bytes.length,
              origin: "file",
              hydrationSuppressed: true,
            },
          ],
        },
      });
      await page.reload();
      await waitForControlUiGatewayReady(page);
      const fileCard = cards.filter({ hasText: filename });
      const downloadFile = async (link: Locator) => {
        // Focus keeps the action exposed while reloaded images move the card.
        await link.focus();
        const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
        expect(await readControlUiE2eDownload(download)).toEqual(bytes);
        expect(download.suggestedFilename()).toBe(filename);
      };
      await downloadFile(fileCard.getByRole("link", { name: `Download ${filename}`, exact: true }));
      await fileCard
        .getByRole("button", { name: `Open ${filename} in the side panel`, exact: true })
        .click();
      await downloadFile(page.locator("openclaw-chat-detail-panel:visible").locator("a[download]"));
    });
  });
});
