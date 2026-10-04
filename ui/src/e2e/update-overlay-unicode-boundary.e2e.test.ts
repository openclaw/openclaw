import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Update failure Unicode boundary" });

suite.define(() => {
  it("renders a recorded failure cause without splitting Unicode", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const config = { update: { auto: { enabled: false }, channel: "stable" } };
        const gateway = await installMockGateway(page, {
          featureMethods: ["config.get", "update.status"],
          methodResponses: {
            "config.get": {
              config,
              hash: "update-unicode-boundary",
              issues: [],
              raw: JSON.stringify(config),
              runtimeConfig: config,
              valid: true,
            },
            "update.status": {
              sentinel: {
                kind: "update",
                status: "error",
                ts: 1_700_000_000_000,
                stats: {
                  mode: "package",
                  reason: "build-failed",
                  steps: [
                    {
                      name: "build",
                      log: { exitCode: 1, stderrTail: `${"x".repeat(179)}😀tail` },
                    },
                  ],
                },
              },
            },
          },
          operatorScopes: ["operator.read", "operator.admin"],
        });

        expect((await page.goto(`${suite.server.baseUrl}settings/updates`))?.status()).toBe(200);
        await gateway.waitForRequest("update.status");
        const status = page.locator("#config-section-update .settings-status");
        await status.filter({ hasText: "x".repeat(179) }).waitFor();
        const statusText = (await status.textContent()) ?? "";
        const displayedCause = statusText.match(/x{2,}/u)?.[0] ?? "";
        expect(displayedCause).toBe("x".repeat(179));
        expect(statusText).not.toContain("😀tail");
        expect(statusText).not.toMatch(/[\p{Surrogate}\uFFFD]/u);
        console.info("update failure Unicode-boundary proof", {
          displayedCauseCodeUnits: displayedCause.length,
          containsSurrogate: /\p{Surrogate}/u.test(statusText),
          containsReplacement: statusText.includes("\uFFFD"),
          containsEmojiTail: statusText.includes("😀tail"),
        });
      },
    );
  });
});
