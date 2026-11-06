import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const baseline = process.env.OPENCLAW_QUOTA_PROOF_STAGE === "before";
const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const suite = createControlUiE2eSuite({
  name: "Chat quota account identity",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});
const visualCases = [
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark" as const },
  { name: "desktop-light", width: 1440, height: 900, theme: "light" as const },
  { name: "phone-dark", width: 390, height: 844, theme: "dark" as const },
  { name: "phone-light", width: 390, height: 844, theme: "light" as const },
  {
    name: "reversed-desktop-dark",
    width: 1440,
    height: 900,
    theme: "dark" as const,
    reverse: true,
  },
  { name: "unknown-phone-light", width: 390, height: 844, theme: "light" as const, unknown: true },
];
// The viewport/theme matrix is proof-only; CI keeps the two distinct behavior paths.
const cases = capture
  ? visualCases
  : visualCases.filter(({ name }) => name === "desktop-dark" || name === "unknown-phone-light");
const accounts = [
  { id: "openai:one", email: "first@example.test", percent: 10 },
  { id: "openai:two", email: "second@example.test", percent: 80 },
] as const;

suite.define(() => {
  it.each(cases)("keeps quota tied to session identity: $name", async (scenario) => {
    await suite.withPage(
      { viewport: { width: scenario.width, height: scenario.height }, colorScheme: scenario.theme },
      async ({ page }) => {
        const sessionKey = "agent:main:quota-identity";
        const session = {
          key: sessionKey,
          kind: "direct" as const,
          label: "Quota account identity",
          model: "demo-model",
          modelProvider: "openai",
          contextTokens: 100_000,
          totalTokens: 14_000,
          estimatedCostUsd: 0.02,
          totalTokensFresh: true,
          updatedAt: 1,
        };
        const providers = (scenario.reverse ? accounts.toReversed() : accounts).map((account) => ({
          provider: "openai",
          displayName: "OpenAI",
          status: "ok",
          profiles: [{ profileId: account.id, type: "oauth", status: "ok" }],
          usage: {
            providerId: "openai",
            authProfileId: account.id,
            displayName: "OpenAI",
            plan: "Test plan",
            accountEmail: account.email,
            windows: [{ label: "5h", usedPercent: account.percent }],
          },
        }));
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessions: [session],
          agentModel: "openai/demo-model",
          models: [
            { id: "demo-model", provider: "openai", name: "Demo model", contextWindow: 100_000 },
          ],
          historyMessages: [
            {
              role: "assistant",
              content: "Quota must follow this session's account, not provider response order.",
            },
          ],
          methodResponses: {
            "models.list": {
              models: [
                {
                  id: "demo-model",
                  provider: "openai",
                  name: "Demo model",
                  contextWindow: 100_000,
                },
              ],
              accountSelection: scenario.unknown
                ? { kind: "automatic", label: "Automatic" }
                : { kind: "shared", label: "Selected account", authProfileId: "openai:two" },
            },
            "models.authStatus": { providers },
            "cron.list": {
              jobs: [],
              snapshotRevision: "quota-empty",
              offset: 0,
              limit: 50,
              total: 0,
              hasMore: false,
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        if (scenario.width <= 900) {
          await page
            .locator(".agent-chat__composer-combobox > textarea")
            .filter({ visible: true })
            .click();
        }
        const ring = page.locator(".context-ring").filter({ visible: true });
        await ring.waitFor({ state: "visible" });
        await ring.focus();
        await page.keyboard.press("Enter");
        const panel = page.locator(".context-usage__popover");
        await panel.waitFor({ state: "visible" });
        const expectedAccount = baseline
          ? scenario.reverse
            ? accounts[1]
            : accounts[0]
          : accounts[1];
        const unknown = !baseline && scenario.unknown;
        const semantic = unknown
          ? panel.getByText("Quota account unknown", { exact: true })
          : panel.getByText(expectedAccount.email, { exact: true });
        await expect.poll(() => semantic.isVisible()).toBe(true);
        if (unknown) {
          expect(await panel.locator(".context-usage__account").count()).toBe(0);
        } else {
          expect(await panel.locator(".context-usage__limit-value").allTextContents()).toContain(
            `${expectedAccount.percent}%`,
          );
        }
        expect((await gateway.getRequests("models.authStatus")).length).toBeGreaterThan(0);
        if (capture) {
          const directory = createControlUiE2eArtifactDir(
            `${baseline ? "before" : "after"}-${scenario.name}`,
            process.env.OPENCLAW_QUOTA_PROOF_DIR,
          );
          const frame = await takeControlUiScreenshotFrame(page, panel, [semantic], {
            elements: [panel],
            animations: "disabled",
          });
          await writeFile(path.join(directory, "viewport.png"), frame.png);
          await writeFile(path.join(directory, "quota-panel.png"), frame.elements[0]!.png);
          await writeFile(
            path.join(directory, "receipt.json"),
            JSON.stringify(
              {
                stage: baseline ? "before" : "after",
                scenario,
                expectedAccount: unknown ? null : expectedAccount,
                bounds: frame.elements[0]!.bounds,
              },
              null,
              2,
            ),
          );
        }
        expect(await panel.textContent()).not.toContain("Cost");
        if (!scenario.unknown && !scenario.reverse) {
          await gateway.setMethodResponse("models.authStatus", {
            providers: [
              {
                provider: "openai",
                displayName: "OpenAI",
                status: "ok",
                profiles: [{ profileId: "openai:two", type: "oauth", status: "ok" }],
                usage: {
                  providerId: "openai",
                  authProfileId: "openai:one",
                  plan: "First account plan",
                  windows: [],
                },
              },
            ],
          });
          await gateway.emitGatewayEvent("chat.metadata.changed", {});
          await page.locator(".context-usage summary").click();
          const picker = page.locator(".agent-chat__input .chat-controls__model-picker").first();
          await picker.locator("[data-chat-model-select]").click();
          const expected = baseline ? "First account plan" : "Subscription";
          await expect.poll(() => picker.textContent()).toContain(expected);
          if (!baseline) {
            expect(await picker.textContent()).not.toContain("First account plan");
          }
          if (capture) {
            const dir = createControlUiE2eArtifactDir(
              (baseline ? "before" : "after") + "-picker-" + scenario.name,
              process.env.OPENCLAW_QUOTA_PROOF_DIR,
            );
            const frame = await takeControlUiScreenshotFrame(
              page,
              picker,
              [picker.getByText(expected, { exact: true }).first()],
              { elements: [picker], animations: "disabled" },
            );
            await writeFile(path.join(dir, "viewport.png"), frame.png);
          }
        }
      },
    );
  });
});
