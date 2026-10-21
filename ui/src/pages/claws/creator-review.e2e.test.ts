import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../../test-helpers/control-ui-e2e.ts";

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
let browser: Browser;
let server: ControlUiE2eServer;

describe.skipIf(!canRunPlaywrightChromium(executablePath))(
  "Claw creator review in the main chat",
  () => {
    beforeAll(async () => {
      server = await startControlUiE2eServer(undefined, { source: true });
      browser = await chromium.launch({ executablePath });
    });
    afterAll(async () => {
      await browser?.close();
      await server?.close();
    });

    it("opens a compact package modal, removes an optional file, and submits the reviewed selection", async () => {
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1200, height: 850 },
      });
      const page = await context.newPage();
      const draftId = "ec8f46b0-4ca3-4991-8a73-dfdcc8764087";
      const scope = {
        input: "A public repository",
        job: "Summarize its releases",
        output: "A release brief",
        authority: "Read public sources only",
      };
      const reviewed = {
        revision: "a".repeat(64),
        reviewToken: "b".repeat(64),
        publisher: "maker",
        name: "@maker/release-brief",
        version: "0.1.0",
        description: "Summarizes releases for a new user.",
        items: [
          {
            id: "file:workspace/checklist.md",
            kind: "file",
            label: "workspace/checklist.md",
            detail: "Check each date and citation.",
            included: true,
          },
          {
            id: "package:plugin:@maker/github",
            kind: "plugin",
            label: "@maker/github",
            detail: "clawhub · 2.0.0",
            included: true,
          },
        ],
        files: [
          { path: "CLAW.md", content: "Portable release instructions" },
          { path: "package.json", content: '{"name":"@maker/release-brief"}' },
          { path: "workspace/checklist.md", content: "Check each date and citation." },
        ],
        scope,
      };
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "claws.drafts.create",
          "claws.drafts.read",
          "claws.drafts.review",
          "claws.drafts.publish",
        ],
        methodResponses: {
          "claws.drafts.read": {
            content: JSON.stringify({ name: "release-brief", scope }),
            revision: reviewed.revision,
          },
          "claws.drafts.review": reviewed,
          "claws.drafts.publish": {
            name: reviewed.name,
            version: reviewed.version,
            url: "https://clawhub.ai/maker/claws/release-brief",
            publicationStatus: "pending",
          },
        },
      });
      try {
        await page.goto(`${server.baseUrl}agents/claws?draft=${draftId}&agent=main`);
        const dialog = page.getByRole("dialog", { name: "Review your Claw" });
        await dialog.waitFor();
        expect(await dialog.getByLabel("Name").inputValue()).toBe("release-brief");
        expect(await dialog.getByLabel("Description").inputValue()).toBe(
          "Summarizes releases for a new user.",
        );
        expect(await dialog.getByRole("textbox", { name: /JSON/i }).count()).toBe(0);
        if (process.env.OPENCLAW_UPDATE_E2E_SCREENSHOTS === "1") {
          const dir = createControlUiE2eArtifactDir("claw-creator-review");
          await page.screenshot({ path: `${dir}/review.png`, animations: "disabled" });
        }
        await gateway.setMethodResponse("claws.drafts.review", {
          ...reviewed,
          reviewToken: "c".repeat(64),
          items: reviewed.items.map((item) =>
            item.kind === "file" ? { ...item, included: false } : item,
          ),
          files: reviewed.files.filter((file) => file.path !== "workspace/checklist.md"),
        });
        await dialog.getByRole("checkbox", { name: "workspace/checklist.md" }).uncheck();
        await expect
          .poll(async () => (await gateway.getRequests("claws.drafts.review")).length)
          .toBe(2);
        const requests = await gateway.getRequests("claws.drafts.review");
        expect(requests[1]?.params).toMatchObject({
          choices: { excluded: ["file:workspace/checklist.md"] },
        });
        await gateway.deferNext("claws.drafts.publish");
        await dialog.getByRole("button", { name: "Publish to ClawHub" }).click();
        await gateway.waitForRequest("claws.drafts.publish");
        await dialog.getByRole("button", { name: "Refresh review" }).waitFor({
          state: "detached",
        });
        await expect
          .poll(() => dialog.locator("button.btn.primary").getAttribute("aria-busy"))
          .toBe("true");
        expect(await dialog.locator("openclaw-modal-actions button").count()).toBe(2);
        await dialog.locator(".btn__spinner").waitFor({ state: "visible" });
        await gateway.rejectDeferred("claws.drafts.publish", {
          code: "UNAVAILABLE",
          message: "The package upload was interrupted.",
        });
        await dialog.getByRole("alert").waitFor();
        expect(await dialog.getByRole("alert").textContent()).toContain(
          "The package upload was interrupted.",
        );
        expect(await dialog.getByRole("button", { name: "Publish to ClawHub" }).isDisabled()).toBe(
          true,
        );
        await gateway.setMethodResponse("claws.drafts.review", {
          ...reviewed,
          reviewToken: "d".repeat(64),
          items: reviewed.items.map((item) =>
            item.kind === "file" ? { ...item, included: false } : item,
          ),
          files: reviewed.files.filter((file) => file.path !== "workspace/checklist.md"),
        });
        await dialog.getByRole("button", { name: "Refresh review" }).click();
        await expect
          .poll(async () => (await gateway.getRequests("claws.drafts.review")).length)
          .toBe(3);
        await expect
          .poll(() => dialog.getByRole("button", { name: "Publish to ClawHub" }).isEnabled())
          .toBe(true);
        await dialog.getByRole("button", { name: "Publish to ClawHub" }).click();
        await expect
          .poll(async () => (await gateway.getRequests("claws.drafts.publish")).length)
          .toBe(2);
        const published = await gateway.getRequests("claws.drafts.publish");
        expect(published[1]?.params).toMatchObject({
          reviewToken: "d".repeat(64),
          choices: { excluded: ["file:workspace/checklist.md"] },
        });
        await page
          .getByText("Submitted to ClawHub. Publication pending security review.")
          .waitFor({ state: "visible" });
        await page.getByRole("button", { name: "View on ClawHub" }).waitFor({ state: "visible" });
        expect(await page.locator(".claw-creator__notice").count()).toBe(0);
        await page.mouse.move(0, 0);
        await page
          .getByText("Submitted to ClawHub. Publication pending security review.")
          .waitFor({ state: "hidden", timeout: 8000 });
        expect(await dialog.count()).toBe(0);
      } finally {
        await context.close();
      }
    });

    it("shows a failed settings action and lets the creator retry there", async () => {
      const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      const config = { gateway: { controlUi: { experimental: { claws: true } } } };
      const gateway = await installMockGateway(page, {
        featureMethods: ["claws.drafts.create", "chat.send"],
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            resolved: config,
            raw: JSON.stringify(config),
            hash: "claws-create-error-config",
            path: "/tmp/openclaw-claws-create-error.json",
            valid: true,
            issues: [],
          },
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "main", name: "Main" }],
          },
        },
      });
      try {
        await page.goto(`${server.baseUrl}settings/agents/main`);
        await gateway.deferNext("claws.drafts.create");
        await page.getByRole("button", { name: "Create Claw" }).click();
        await gateway.waitForRequest("claws.drafts.create");
        await gateway.rejectDeferred("claws.drafts.create", {
          code: "UNAVAILABLE",
          message: "The agent workspace is unavailable.",
        });
        await page.getByText("The agent workspace is unavailable.").waitFor();
        expect(new URL(page.url()).pathname).toContain("/settings/agents/main");

        await gateway.setMethodResponse("claws.drafts.create", {
          draftId: "ec8f46b0-4ca3-4991-8a73-dfdcc8764087",
          prompt: "$create-claw Create a Claw from this agent and turn it into a shareable Claw.",
        });
        await gateway.setMethodResponse("chat.send", { status: "started" });
        await page.getByRole("button", { name: "Retry" }).click();
        await gateway.waitForRequest("chat.send");
        await page.waitForURL(/\/chat\/main/u);
      } finally {
        await context.close();
      }
    });

    it("starts from the main chat header and sends the bundled skill prompt in the main session", async () => {
      const context = await browser.newContext({ locale: "en-US", serviceWorkers: "block" });
      const page = await context.newPage();
      const config = { gateway: { controlUi: { experimental: { claws: true } } } };
      const gateway = await installMockGateway(page, {
        featureMethods: ["claws.drafts.create", "chat.send"],
        methodResponses: {
          "config.get": {
            config,
            sourceConfig: config,
            resolved: config,
            raw: JSON.stringify(config),
            hash: "claws-create-header-config",
            path: "/tmp/openclaw-claws-create-header.json",
            valid: true,
            issues: [],
          },
          "agents.list": {
            defaultId: "main",
            mainKey: "main",
            scope: "per-sender",
            agents: [{ id: "main", name: "Main" }],
          },
          "claws.drafts.create": {
            draftId: "ec8f46b0-4ca3-4991-8a73-dfdcc8764087",
            prompt: "$create-claw Create a Claw from this agent and turn it into a shareable Claw.",
          },
          "chat.send": { status: "started" },
        },
      });
      try {
        await page.goto(`${server.baseUrl}chat/main`);
        await page.getByRole("button", { name: "Create Claw" }).click();
        await gateway.waitForRequest("claws.drafts.create");
        await gateway.waitForRequest("chat.send");
        const sent = (await gateway.getRequests("chat.send"))[0]?.params;
        expect(sent).toMatchObject({
          sessionKey: "agent:main:main",
          message: "$create-claw Create a Claw from this agent and turn it into a shareable Claw.",
          workContext: {
            page: "claw-create",
            detail: { draftId: "ec8f46b0-4ca3-4991-8a73-dfdcc8764087" },
          },
        });
        expect((sent as { message: string } | undefined)?.message).not.toContain(
          "ec8f46b0-4ca3-4991-8a73-dfdcc8764087",
        );
      } finally {
        await context.close();
      }
    });
  },
);
