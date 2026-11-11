import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  takeControlUiScreenshotFrame,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { selectAgentFileWorkspace } from "./agent-file-lifecycle.test-support.ts";
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

function requestAgentId(request: { params?: unknown }) {
  return (request.params as { agentId?: unknown } | undefined)?.agentId;
}

const fileListResponses = {
  cases: [
    { match: { agentId: "main" }, response: fileList("main") },
    { match: { agentId: "writer" }, response: fileList("writer") },
    { response: fileList("main") },
  ],
};

function fileGetResponses(mainContent: string) {
  return {
    cases: [
      ...Object.entries({ main: mainContent, writer: "# Writer instructions\n" }).map(
        ([agentId, content]) => ({
          match: { agentId, name: "AGENTS.md" },
          response: fileGet(agentId, content),
        }),
      ),
      { response: fileGet("main", mainContent) },
    ],
  };
}

type FileOptions = Pick<
  NonNullable<Parameters<typeof installMockGateway>[1]>,
  "deferredMethods" | "methodResponses"
> & { writer?: boolean };

function withFilePage(
  content: string,
  run: (fixture: Awaited<ReturnType<typeof prepareFilePage>>) => Promise<void>,
  options: FileOptions = {},
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

async function prepareFilePage(page: Page, content: string, options: FileOptions) {
  const gateway = await installMockGateway(page, {
    featureMethods: ["agents.files.get", "agents.files.list", "agents.files.set", "agents.list"],
    operatorScopes: ["operator.admin", "operator.read", "operator.write"],
    deferredMethods: options.deferredMethods,
    methodResponses: {
      "agents.list": {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Main" },
          ...(options.writer ? [{ id: "writer", name: "Writer" }] : []),
        ],
      },
      "agents.files.get": fileGetResponses(content),
      "agents.files.list": fileListResponses,
      ...options.methodResponses,
    },
  });
  await page.goto(`${suite.server.baseUrl}settings/agents/main/files`);
  const actions = page.locator(".agent-file-actions");
  return {
    page,
    gateway,
    editor: page.locator(".agent-file-textarea"),
    reset: actions.getByRole("button", { name: "Reset" }),
    save: actions.getByRole("button", { name: "Save" }),
    preview: actions.getByRole("button", { name: "Preview", exact: true }),
    refresh: page
      .locator(".settings-section")
      .filter({ has: page.getByRole("heading", { name: "Core files" }) })
      .getByRole("button", { name: "Refresh", exact: true }),
    waitForRequests: (method: string, count: number) =>
      expect.poll(async () => (await gateway.getRequests(method)).length).toBe(count),
    respondWith: (value: string) =>
      gateway.setMethodResponse("agents.files.get", fileGetResponses(value)),
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
  it("keeps preview tooltip aligned with its expand state", async () => {
    const content = "# Preview tooltip fixture\n\nSynthetic preview instructions.\n";
    await withFilePage(content, async ({ page, gateway, editor, preview }) => {
      await expect.poll(() => editor.inputValue()).toBe(content);
      const modal = page.locator("openclaw-modal-dialog:has(.md-preview-expand-btn)");
      const dialog = modal.locator("dialog");
      const panel = modal.locator(".md-preview-dialog__panel");
      const reader = modal.locator(".md-preview-dialog__reader");
      const expand = modal.locator(".md-preview-expand-btn");
      const tooltipHost = modal.locator("openclaw-tooltip:has(.md-preview-expand-btn)");
      // Hover-intent timing is covered by the tooltip owner's fake-clock tests.
      await tooltipHost.evaluate((element) => element.setAttribute("delay", "0"));
      const tooltip = tooltipHost.locator(".tooltip-surface[popover]");
      const hint = tooltip.locator(".tooltip-content");
      const settlePreview = async () => {
        await waitForControlUiProofSurface(dialog, [reader]);
        await waitForControlUiProofSurface(panel, [reader]);
      };
      const assertHint = async (label: string) => {
        await reader.hover();
        await expand.hover();
        await waitForControlUiProofSurface(tooltip, [hint, expand]);
        expect(
          await expand.evaluate((anchor) => {
            const host = anchor.closest<HTMLElement & { anchor?: Element }>("openclaw-tooltip");
            const tooltipAnchor =
              host?.anchor ??
              host?.shadowRoot
                ?.querySelector<HTMLSlotElement>("slot:not([name])")
                ?.assignedElements({ flatten: true })[0];
            return tooltipAnchor === anchor;
          }),
        ).toBe(true);
        expect((await hint.textContent())?.trim()).toBe(label);
        expect(await expand.getAttribute("aria-label")).toBe(label);
        expect(await hint.isVisible()).toBe(true);
      };
      const toggle = async () => {
        await expand.click();
        await hint.waitFor({ state: "hidden" });
        await settlePreview();
      };
      const assertExpanded = async (expanded: boolean) => {
        expect(await expand.getAttribute("aria-pressed")).toBe(String(expanded));
        expect(await panel.evaluate((element) => element.classList.contains("fullscreen"))).toBe(
          expanded,
        );
      };
      await preview.click();
      await settlePreview();
      const normalBox = await dialog.boundingBox();
      expect(normalBox).not.toBeNull();
      await assertExpanded(false);
      await assertHint("Expand preview");
      for (const action of ["collapse", "Close preview", "Edit file", "Escape"]) {
        await toggle();
        await assertExpanded(true);
        const expandedBox = await dialog.boundingBox();
        expect(Boolean(normalBox && expandedBox && expandedBox.width > normalBox.width)).toBe(true);
        await assertHint("Collapse preview");
        if (action === "collapse") {
          await toggle();
        } else {
          if (action === "Escape") {
            await page.keyboard.press("Escape");
            await hint.waitFor({ state: "hidden" });
            expect(await dialog.isVisible()).toBe(true);
            await page.keyboard.press("Escape");
          } else {
            await modal.getByRole("button", { name: action, exact: true }).click();
          }
          await dialog.waitFor({ state: "hidden" });
          expect(await editor.inputValue()).toBe(content);
          await preview.click();
          await settlePreview();
        }
        await assertExpanded(false);
        const resetBox = await dialog.boundingBox();
        expect(Boolean(resetBox && expandedBox && resetBox.width < expandedBox.width)).toBe(true);
        await assertHint("Expand preview");
      }
      await modal.getByRole("button", { name: "Close preview", exact: true }).click();
      await dialog.waitFor({ state: "hidden" });
      expect(await editor.inputValue()).toBe(content);
      expect((await page.locator(".agent-file-sub").textContent())?.trim()).toBe(
        "/tmp/openclaw-e2e/workspace-main/AGENTS.md",
      );
      expect(
        (await gateway.getRequests()).filter((request) =>
          ["agents.files.set", "config.set", "config.patch", "config.apply"].includes(
            request.method,
          ),
        ),
      ).toEqual([]);
    });
  });

  it("protects initial file reads, retries errors, and rejects stale cross-agent reads", async () => {
    await withFilePage(
      "# Main instructions\n",
      async (fixture) => {
        const { page, gateway, editor, save, preview, refresh } = fixture;
        const { waitForRequests, respondWith, confirmSave } = fixture;
        const initialRead = await gateway.waitForRequest("agents.files.get");
        expect(initialRead.params).toMatchObject({ agentId: "main", name: "AGENTS.md" });
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

        await editor.fill("Updated main instructions");
        await save.click();
        await waitForRequests("agents.files.set", 1);
        await expect
          .poll(() => page.getByText(/workspace write failed; retry Save/).isVisible())
          .toBe(true);
        expect(await gateway.getRequests("agents.files.list")).toHaveLength(2);

        await confirmSave("Updated main instructions");
        await save.click();
        await waitForRequests("agents.files.set", 2);
        await expect
          .poll(() => page.getByText(/workspace write failed; retry Save/).count())
          .toBe(0);
        await expect.poll(() => save.isDisabled()).toBe(true);

        await respondWith("Updated main instructions");
        await gateway.deferNext("agents.files.get", { agentId: "writer", name: "AGENTS.md" });
        await selectAgentFileWorkspace(page, "Writer");
        await gateway.waitForRequest("agents.files.get", { match: { agentId: "writer" } });
        await selectAgentFileWorkspace(page, "Main");
        await expect.poll(() => editor.inputValue()).toBe("Updated main instructions");
        await gateway.resolveDeferred("agents.files.get", fileGet("writer", "stale writer"));
        await expect.poll(() => editor.inputValue()).toBe("Updated main instructions");

        await selectAgentFileWorkspace(page, "Writer");
        await expect.poll(() => editor.inputValue()).toBe("# Writer instructions\n");
        const writes = await gateway.getRequests("agents.files.set");
        expect(writes.every((request) => requestAgentId(request) === "main")).toBe(true);
      },
      {
        writer: true,
        deferredMethods: ["agents.files.get"],
        methodResponses: {
          "agents.files.set": {
            __mockError: {
              code: "INTERNAL_ERROR",
              message: "workspace write failed; retry Save",
              retryable: true,
            },
          },
        },
      },
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

  it("preserves drafts and confirmed saves across overlapping refreshes", async () => {
    await withFilePage("server revision 1", async (fixture) => {
      const { page, gateway, editor, refresh, reset, save } = fixture;
      const { waitForRequests, respondWith, confirmSave } = fixture;
      await expect.poll(() => editor.inputValue()).toBe("server revision 1");

      await respondWith("server revision 2");
      await refresh.click();
      await waitForRequests("agents.files.get", 2);
      await expect.poll(() => editor.inputValue()).toBe("server revision 2");
      await expect.poll(() => editor.isEnabled()).toBe(true);

      await editor.fill("local dirty draft");
      await respondWith("server revision 3");
      await refresh.click();
      await waitForRequests("agents.files.get", 3);
      await expect.poll(() => editor.inputValue()).toBe("local dirty draft");
      await expect.poll(() => editor.isEnabled()).toBe(true);
      await expect.poll(() => reset.isEnabled()).toBe(true);
      await reset.click();
      await expect.poll(() => editor.inputValue()).toBe("server revision 3");
      await expect.poll(() => reset.isDisabled()).toBe(true);
      await expect.poll(() => save.isDisabled()).toBe(true);

      await gateway.deferNext("agents.files.get", { agentId: "main", name: "AGENTS.md" });
      await refresh.click();
      await waitForRequests("agents.files.get", 4);
      await editor.fill("Saved latest instructions");
      await confirmSave("Saved latest instructions");
      await respondWith("Saved latest instructions");
      await save.click();
      await expect.poll(() => save.isDisabled()).toBe(true);
      await gateway.resolveDeferred("agents.files.get", fileGet("main", "server revision 3"));
      await expect.poll(() => refresh.isEnabled()).toBe(true);
      await expect.poll(() => editor.inputValue()).toBe("Saved latest instructions");
      await expect.poll(() => reset.isDisabled()).toBe(true);

      const missingFile = { ...fileList("main").files[0], missing: true, content: "" };
      const missingList = { ...fileList("main"), files: [missingFile] };
      await gateway.setMethodResponse("agents.files.list", missingList);
      await gateway.setMethodResponse("agents.files.get", { ...missingList, file: missingFile });
      await refresh.click();
      await expect.poll(() => editor.inputValue()).toBe("");
      const missingHint = page.locator("#agent-file-panel .callout.info");
      await expect.poll(() => missingHint.isVisible()).toBe(true);
      await gateway.deferNext("agents.files.list", { agentId: "main" });
      const listsBeforeSave = (await gateway.getRequests("agents.files.list")).length;
      await refresh.click();
      await waitForRequests("agents.files.list", listsBeforeSave + 1);
      await editor.fill("Saved latest instructions");
      await respondWith("Saved latest instructions");
      await save.click();
      await expect.poll(() => missingHint.count()).toBe(0);
      await gateway.resolveDeferred("agents.files.list", missingList);
      await expect.poll(() => refresh.isEnabled()).toBe(true);
      await page.locator(".agents-refresh-btn").click();
      await expect.poll(() => page.locator(".agents-refresh-btn").isEnabled()).toBe(true);
      await expect.poll(() => editor.inputValue()).toBe("Saved latest instructions");
      expect(await missingHint.count()).toBe(0);
    });
  });
});
