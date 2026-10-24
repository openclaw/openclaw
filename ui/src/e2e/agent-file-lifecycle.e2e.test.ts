import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent file lifecycle",
  browserLaunchOptions: { headless: true },
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

function fileList(agentId: string) {
  const workspace = `/tmp/openclaw-e2e/workspace-${agentId}`;
  return {
    agentId,
    workspace,
    files: [{ name: "AGENTS.md", path: `${workspace}/AGENTS.md`, missing: false }],
  };
}

function fileGet(agentId: string, content: string) {
  return {
    ...fileList(agentId),
    file: { ...fileList(agentId).files[0], content },
  };
}

function withFilePage(
  content: string,
  run: (fixture: Awaited<ReturnType<typeof prepareFilePage>>) => Promise<void>,
  options: Pick<NonNullable<Parameters<typeof installMockGateway>[1]>, "deferredMethods"> = {},
) {
  return suite.withPage(
    {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    },
    async ({ page }) => run(await prepareFilePage(page, content, options)),
  );
}

async function prepareFilePage(
  page: Page,
  content: string,
  options: Pick<NonNullable<Parameters<typeof installMockGateway>[1]>, "deferredMethods">,
) {
  const gateway = await installMockGateway(page, {
    ...options,
    featureMethods: ["agents.files.get", "agents.files.list", "agents.files.set", "agents.list"],
    operatorScopes: ["operator.admin", "operator.read", "operator.write"],
    methodResponses: {
      "agents.list": {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main", name: "Main" }],
      },
      "agents.files.get": fileGet("main", content),
      "agents.files.list": fileList("main"),
    },
  });
  await page.goto(`${suite.server.baseUrl}settings/agents/main/files`);
  const actions = page.locator(".agent-file-actions");
  return {
    page,
    gateway,
    editor: page.locator(".agent-file-textarea"),
    save: actions.getByRole("button", { name: "Save" }),
    preview: actions.getByRole("button", { name: "Preview", exact: true }),
    refresh: page
      .locator(".settings-section")
      .filter({ has: page.getByRole("heading", { name: "Core files" }) })
      .getByRole("button", { name: "Refresh", exact: true }),
    confirmSave: (value: string) =>
      gateway.setMethodResponse("agents.files.set", { ok: true, ...fileGet("main", value) }),
  };
}

suite.define(() => {
  it.each([false, true])(
    "announces a failed file save (conflict: %s) without losing the draft",
    async (conflict) => {
      const draft = "# Garden helper\n\nKeep these synthetic instructions.";
      const message = conflict
        ? "Synthetic workspace changed; Reload or Overwrite to recover."
        : "Synthetic write rejected; retry Save.";
      await withFilePage(
        "Original synthetic instructions",
        async ({ page, gateway, editor, save, confirmSave }) => {
          await expect.poll(() => editor.inputValue()).toBe("Original synthetic instructions");
          expect(await page.locator(".agents-main").getByRole("alert").count()).toBe(0);
          await editor.fill(draft);
          await gateway.deferNext("agents.files.set", { agentId: "main", name: "AGENTS.md" });
          await save.click();
          await gateway.waitForRequest("agents.files.set");
          await editor.fill(draft + "\nA newer edit.");
          await gateway.resolveDeferred("agents.files.set", {
            __mockError: {
              code: conflict ? "INVALID_REQUEST" : "UNAVAILABLE",
              message,
              ...(conflict ? { details: { type: "agent_file_conflict", name: "AGENTS.md" } } : {}),
            },
          });
          await page.getByText(message, { exact: true }).waitFor();
          expect(await editor.inputValue()).toBe(draft + "\nA newer edit.");
          expect(await editor.isEnabled()).toBe(true);
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator(".agents-main"),
            [editor, page.getByText(message, { exact: true })],
            { animations: "disabled" },
          );
          writeFileSync(
            path.join(suite.artifactDir, conflict ? "save-conflict.png" : "save-failure.png"),
            frame.png,
          );
          writeFileSync(
            path.join(
              suite.artifactDir,
              conflict ? "save-conflict.aria.txt" : "save-failure.aria.txt",
            ),
            await page.locator(".agents-main").ariaSnapshot(),
          );
          const alert = page.locator(".agents-main").getByRole("alert");
          await expect.poll(() => alert.count()).toBe(1);
          expect(await alert.textContent()).toContain(message);
          if (conflict) {
            expect(
              await alert.getByRole("button", { name: "Reload", exact: true }).isEnabled(),
            ).toBe(true);
            expect(
              await alert.getByRole("button", { name: "Overwrite", exact: true }).isEnabled(),
            ).toBe(true);
          }
          await confirmSave(draft + "\nA newer edit.");
          await save.click();
          await expect.poll(() => save.isDisabled()).toBe(true);
          expect(await alert.count()).toBe(0);
          expect(await editor.inputValue()).toBe(draft + "\nA newer edit.");
        },
      );
    },
  );
  it("disables unread file controls until an explicit retry succeeds", async () => {
    await withFilePage(
      "# Main instructions\n",
      async ({ page, gateway, editor, save, preview, refresh }) => {
        await gateway.waitForRequest("agents.files.get");
        await editor.waitFor({ state: "visible" });
        expect(
          await Promise.all([editor.isDisabled(), preview.isDisabled(), save.isDisabled()]),
        ).toEqual([true, true, true]);
        await gateway.resolveDeferred("agents.files.get", {
          __mockError: { code: "INTERNAL_ERROR", message: "workspace read failed; retry Refresh" },
        });
        await page.getByText("workspace read failed; retry Refresh", { exact: true }).waitFor();
        expect(await Promise.all([editor.isDisabled(), preview.isDisabled()])).toEqual([
          true,
          true,
        ]);
        expect(await gateway.getRequests("agents.files.set")).toHaveLength(0);
        await refresh.click();
        await expect.poll(() => editor.inputValue()).toBe("# Main instructions\n");
        expect(await Promise.all([editor.isEnabled(), preview.isEnabled()])).toEqual([true, true]);
      },
      { deferredMethods: ["agents.files.get"] },
    );
  });

  it("requires explicit recovery before saving a draft to a replacement workspace", async () => {
    const draft = "Draft from workspace A";
    await withFilePage(
      "Shared starter instructions",
      async ({ page, gateway, editor, refresh, save }) => {
        await expect.poll(() => editor.inputValue()).toBe("Shared starter instructions");
        await editor.fill(draft);
        const replacement = {
          ...fileGet("main", "Shared starter instructions"),
          workspace: "/tmp/openclaw-e2e/workspace-b",
          file: {
            ...fileGet("main", "Shared starter instructions").file,
            path: "/tmp/openclaw-e2e/workspace-b/AGENTS.md",
          },
        };
        await gateway.setMethodResponse("agents.files.list", {
          ...replacement,
          files: [replacement.file],
        });
        await gateway.setMethodResponse("agents.files.get", replacement);
        await gateway.setMethodResponse("agents.files.set", {
          cases: [
            {
              match: { expectedWorkspace: fileList("main").workspace },
              response: {
                __mockError: {
                  code: "INVALID_REQUEST",
                  message:
                    'Agent workspace changed since "AGENTS.md" was read. Reload to use the current workspace file, or Overwrite to save this draft there.',
                  details: { type: "agent_file_conflict", name: "AGENTS.md" },
                },
              },
            },
            {
              response: { ok: true, ...replacement, file: { ...replacement.file, content: draft } },
            },
          ],
        });
        await refresh.click();
        await page.locator(".agent-file-sub").filter({ hasText: "workspace-b" }).waitFor();
        await expect.poll(() => refresh.isEnabled()).toBe(true);
        await save.click();
        const conflict = page.locator(".callout.danger");
        await expect
          .poll(async () => (await conflict.count()) > 0 || (await save.isDisabled()))
          .toBe(true);
        const frame = await takeControlUiScreenshotFrame(page, editor, [editor], {
          animations: "disabled",
        });
        writeFileSync(path.join(suite.artifactDir, "workspace-change.png"), frame.png);
        await conflict.filter({ hasText: "workspace changed" }).waitFor();
        expect(await editor.inputValue()).toBe(draft);
        await conflict.getByRole("button", { name: "Overwrite", exact: true }).click();
        await expect.poll(() => save.isDisabled()).toBe(true);
        expect(await conflict.count()).toBe(0);
        const writes = await gateway.getRequests("agents.files.set");
        expect(writes.map((request) => request.params)).toMatchObject([
          { expectedWorkspace: fileList("main").workspace, content: draft },
          { expectedWorkspace: replacement.workspace, content: draft },
        ]);
      },
    );
  });
});
