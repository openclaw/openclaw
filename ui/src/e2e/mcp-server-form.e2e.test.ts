import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { configSnapshot } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Add MCP server dialog" });
const existing = "production_documentation_search_index_for_customer_support_knowledge_base";
suite.define(() => {
  it.each(["settings", "composer"] as const)(
    "keeps a long duplicate name and both dialog actions inside the phone form from %s",
    async (entry) => {
      await suite.withPage(
        {
          viewport: { width: 390, height: 844 },
          hasTouch: true,
          isMobile: true,
          deviceScaleFactor: 1,
        },
        async ({ page }) => {
          const sessionKey = "agent:main:docs-session";
          const gateway = await installMockGateway(page, {
            sessionKey,
            sessions: [{ key: sessionKey, sessionId: "docs-session" }],
            methodResponses: {
              "config.get": configSnapshot(
                { mcp: { servers: { [existing]: { url: "https://docs.example.invalid/mcp" } } } },
                "saved",
              ),
            },
          });
          if (entry === "settings") {
            await page.goto(suite.server.baseUrl + "settings/mcp");
            await page.getByRole("button", { name: "Add server", exact: true }).tap();
          } else {
            await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
            const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
            await pane.getByRole("button", { name: "Add attachment", exact: true }).tap();
            const menu = pane.locator(".agent-chat__capability-menu");
            await menu.getByRole("menuitem", { name: /^Plugins/u }).tap();
            await menu.getByRole("menuitem", { name: "Add MCP server", exact: true }).tap();
          }
          const form = page.locator(".mcp-server-form"),
            name = form.getByRole("textbox", { name: "Name", exact: true }),
            target = form.getByRole("textbox", { name: "URL or command" }),
            add = form.getByRole("button", { name: "Add server", exact: true });
          await name.fill(existing);
          await target.fill("https://another.example.invalid/mcp");
          await add.tap();
          await expect.poll(() => form.getByRole("alert").textContent()).toContain(existing);
          expect(await form.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
          expect(
            await form.evaluate((el) => {
              const r = el.getBoundingClientRect();
              return [...el.querySelectorAll("button")].every((b) => {
                const box = b.getBoundingClientRect();
                return (
                  box.left >= r.left - 1 &&
                  box.right <= r.right + 1 &&
                  b.contains(
                    document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2),
                  )
                );
              });
            }),
          ).toBe(true);
          // Retry from the same dialog, without saving a server or dropping the draft.
          await name.fill("bad name");
          await add.tap();
          await expect
            .poll(() => form.getByRole("alert").textContent())
            .toContain("Server names use");
          expect(await target.inputValue()).toBe("https://another.example.invalid/mcp");
          await add.press("Escape");
          await form.waitFor({ state: "hidden" });
          expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        },
      );
    },
  );
});
