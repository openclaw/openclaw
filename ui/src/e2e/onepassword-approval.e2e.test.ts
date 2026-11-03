import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { resolveRenderedColors } from "../test-helpers/rendered-colors.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Private 1Password inline approval" });
const sessionKey = "agent:main:approval-proof";
const appLink = "onepassword://grant-brokered-access?synthetic-private-proof";
const summary =
  "1Password approval requested for the-internet.herokuapp.com. Approve it in OpenClaw.";
const metadata = {
  goal: "Sign in to the demo site to check your account.",
  entries: [
    {
      domain: "the-internet.herokuapp.com",
      reason: "Use your demo login to open the secure area.",
      granted: false,
    },
  ],
};

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "privately hydrates every designed state in %s, with live approval and no link in history",
    async (theme) => {
      await suite.withPage(
        { viewport: { width: 1280, height: 900 }, colorScheme: theme, serviceWorkers: "block" },
        async ({ page }) => {
          const historyMessages = [
            {
              role: "user",
              content: "Sign in to the demo site with my approved login.",
              timestamp: Date.now(),
            },
            {
              role: "toolResult",
              toolName: "onepassword_autofill",
              toolCallId: "approval-call",
              timestamp: Date.now() + 1,
              content: [{ type: "text", text: summary }],
              details: {
                pluginView: {
                  type: "plugin_view",
                  pluginId: "onepassword",
                  viewId: "approval",
                  version: 1,
                  toolName: "onepassword_autofill",
                  toolCallId: "approval-call",
                  payload: { requestId: "request" },
                  summary,
                },
              },
            },
          ];
          const gateway = await installMockGateway(page, {
            sessionKey,
            historyMessages,
            agentModel: "openai/gpt-4.1",
            nativePlugins: [
              {
                pluginId: "onepassword",
                rootDir: path.resolve("extensions/onepassword"),
                source: "./browser/index.tsx",
                inlineViews: [{ id: "approval", label: "1Password approval", version: 1 }],
              },
            ],
            deferredMethods: ["onepassword.autofill.approval"],
          });
          const view = page.locator('[data-plugin-inline-view="approval-call"]');
          const capture = async (state: string) => {
            const card = view.locator(".onepassword-approval");
            const shot = await takeControlUiScreenshotFrame(page, view, [card], {
              animations: "disabled",
            });
            writeFileSync(`/tmp/op-approval-design-${state}-${theme}.png`, shot.png);
            writeFileSync(path.join(suite.artifactDir, `${state}-${theme}.png`), shot.png);
          };
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
          await evaluateControlUiContext(
            page,
            (context, mode) => context.theme.setMode(mode),
            theme,
          );
          await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(theme);
          await view.getByRole("heading", { name: "Approve sign-in" }).waitFor();
          expect(await view.locator("a").count()).toBe(0);
          const cardHeight = () =>
            view
              .locator(".onepassword-approval")
              .evaluate((card) => card.getBoundingClientRect().height);
          const loadingHeight = await cardHeight();
          await capture("loading");
          await expect
            .poll(async () => (await gateway.getRequests("onepassword.autofill.approval")).length)
            .toBe(1);
          await gateway.resolveDeferred("onepassword.autofill.approval", {
            ...metadata,
            state: "pending",
            appLink,
          });
          const button = view.getByRole("link", { name: "Open 1Password", exact: true });
          await button.waitFor();
          expect(await button.getAttribute("href")).toBe(appLink);
          expect(await view.getByRole("button", { name: "Refresh status" }).count()).toBe(0);
          expect(JSON.stringify(historyMessages)).not.toContain(appLink);
          expect((await page.locator(".chat-bubble").allTextContents()).join("\n")).not.toContain(
            appLink,
          );
          const readyHeight = await cardHeight();
          expect(Math.abs(readyHeight - loadingHeight)).toBeLessThanOrEqual(2);
          expect(
            await view
              .locator(".onepassword-approval__eyebrow, .onepassword-approval__private")
              .count(),
          ).toBe(0);
          await capture("ready");
          const colors = await page.evaluate(
            resolveRenderedColors,
            await view.locator(".onepassword-approval").evaluate((card) => ({
              text: getComputedStyle(card).color,
              muted: getComputedStyle(card).getPropertyValue("--muted"),
              card: getComputedStyle(card).backgroundColor,
              footer: getComputedStyle(card.querySelector("footer")!).backgroundColor,
              action: getComputedStyle(card.querySelector("a")!).backgroundColor,
              actionText: getComputedStyle(card.querySelector("a")!).color,
            })),
          );
          for (const [front, back] of [
            ["text", "card"],
            ["muted", "card"],
            ["muted", "footer"],
            ["actionText", "action"],
          ]) {
            const luminance = (name: string) => {
              const color = colors[name]!;
              expect(color.alpha).toBe(1);
              const linear = [color.red, color.green, color.blue]
                .map((channel) => channel / 255)
                .map((value) =>
                  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
                );
              return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
            };
            const values = [luminance(front!), luminance(back!)];
            expect(
              (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05),
              `${theme}: ${front} on ${back}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
          await button.focus();
          expect(await button.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe(
            "solid",
          );
          await button.press("Tab");
          // Suppress only OS navigation; exercise the real native-view click and private RPC.
          await button.evaluate((anchor) =>
            anchor.addEventListener("click", (event) => event.preventDefault()),
          );
          await gateway.deferNext("onepassword.autofill.approval", { action: "opened" });
          await button.click();
          await expect
            .poll(async () => (await gateway.getRequests("onepassword.autofill.approval")).length)
            .toBe(2);
          expect(
            (await gateway.getRequests("onepassword.autofill.approval"))[1]?.params,
          ).toMatchObject({ action: "opened", requestId: "request", sessionKey });
          await gateway.deferNext("onepassword.autofill.approval", { action: "get" });
          await gateway.resolveDeferred("onepassword.autofill.approval", {
            ...metadata,
            state: "pending",
            appLink,
            openedAt: Date.now() - 35_000,
            deadline: Date.now() + 85_000,
          });
          await view
            .getByRole("status")
            .filter({ hasText: "Waiting for you in 1Password" })
            .waitFor();
          await page.emulateMedia({ reducedMotion: "reduce" });
          expect(
            await view
              .locator(".onepassword-approval__pulse")
              .evaluate((element) => getComputedStyle(element).animationName),
          ).toBe("none");
          expect(Math.abs((await cardHeight()) - readyHeight)).toBeLessThanOrEqual(2);
          await view
            .getByText("Nothing opened? Open this chat on a computer with the 1Password app.", {
              exact: true,
            })
            .waitFor();
          expect(await view.getByRole("button").count()).toBe(0);
          expect(await view.getByRole("link", { name: "Open again", exact: true }).count()).toBe(1);
          await capture("waiting");
          await expect
            .poll(async () => (await gateway.getRequests("onepassword.autofill.approval")).length)
            .toBeGreaterThanOrEqual(3);
          await gateway.resolveDeferred("onepassword.autofill.approval", {
            ...metadata,
            state: "resolved",
            entries: [{ ...metadata.entries[0]!, granted: true }],
          });
          await view.getByText("Sign-in approved", { exact: true }).waitFor();
          await capture("approved");
          expect(await view.locator("a").count()).toBe(0);
          for (const [state, title] of [
            ["denied", "Sign-in not approved"],
            ["settling", "Checking your decision"],
            ["expired", "Approval expired"],
            ["unavailable", "Approval link unavailable"],
            ["failed", "Sign-in failed"],
          ]) {
            await page.reload();
            await view.getByRole("heading", { name: "Approve sign-in" }).waitFor();
            await expect
              .poll(async () => (await gateway.getRequests("onepassword.autofill.approval")).length)
              .toBe(1);
            await gateway.resolveDeferred("onepassword.autofill.approval", { ...metadata, state });
            await view.getByText(title!, { exact: true }).waitFor();
            if (state === "settling") {
              expect(Math.abs((await cardHeight()) - readyHeight)).toBeLessThanOrEqual(2);
            }
            await capture(state!);
            expect(await view.locator("a").count()).toBe(0);
          }
          expect(JSON.stringify(await gateway.getRequests("chat.send"))).not.toContain(appLink);
          expect((await gateway.getRequests("chat.send")).length).toBe(0);
          expect((await gateway.getRequests("sessions.messages.subscribe")).length).toBeGreaterThan(
            0,
          );
        },
      );
    },
  );
});
