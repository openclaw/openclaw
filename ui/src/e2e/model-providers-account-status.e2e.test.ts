import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expandProvider } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Model account status distinctions" });
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";

suite.define(() => {
  it("separates access-token expiry, sign-in recovery, quota and temporary rate limits", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 1000 } },
      async ({ page }) => {
        const now = Date.now();
        const expiry = { at: now + 3_600_000, remainingMs: 3_600_000, label: "1h" };
        const providers = [
          {
            provider: "example-oauth",
            displayName: "Example OAuth",
            status: "expiring",
            expiry,
            profiles: [
              {
                profileId: "example-oauth:account",
                displayName: "Example account",
                type: "oauth",
                status: "expiring",
                expiry,
              },
            ],
          },
          {
            provider: "example-reauth",
            displayName: "Example reconnect",
            status: "expired",
            profiles: [
              {
                profileId: "example-reauth:account",
                displayName: "Reconnect account",
                type: "oauth",
                status: "expired",
                reasonCode: "expired",
              },
            ],
          },
          {
            provider: "example-quota",
            displayName: "Example quota",
            status: "expiring",
            expiry,
            profiles: [
              {
                profileId: "example-quota:account",
                displayName: "Quota account",
                type: "oauth",
                status: "expiring",
                expiry,
              },
            ],
          },
          {
            provider: "example-rate",
            displayName: "Example rate limit",
            status: "expiring",
            expiry,
            profiles: [
              {
                profileId: "example-rate:account",
                displayName: "Rate-limited account",
                type: "oauth",
                status: "expiring",
                expiry,
              },
            ],
          },
          {
            provider: "example-mixed",
            displayName: "Example mixed credentials",
            status: "static",
            profileOrder: ["example-mixed:api-key"],
            profiles: [
              { profileId: "example-mixed:api-key", type: "api_key", status: "static" },
              {
                profileId: "example-mixed:excluded",
                displayName: "Excluded account",
                type: "oauth",
                status: "expired",
                reasonCode: "expired",
              },
            ],
          },
          {
            provider: "example-selected",
            displayName: "Example selected token",
            status: "expiring",
            expiry,
            profileOrder: ["example-selected:token"],
            profiles: [
              { profileId: "example-selected:token", type: "token", status: "expiring", expiry },
              {
                profileId: "example-selected:excluded",
                displayName: "Excluded account",
                type: "oauth",
                status: "missing",
                reasonCode: "missing_credential",
              },
            ],
          },
          {
            provider: "example-token",
            displayName: "Example static token",
            status: "expired",
            profiles: [
              {
                profileId: "example-token:account",
                type: "token",
                status: "expired",
                reasonCode: "expired",
              },
            ],
          },
        ];
        await installMockGateway(page, {
          methodResponses: {
            "config.get": { config: {}, hash: "synthetic-status" },
            "models.authStatus": { ts: now, providers },
            "models.list": {
              models: [
                {
                  id: "example-model",
                  name: "Example model",
                  provider: "example-oauth",
                  available: true,
                },
              ],
              providerOutcomes: [
                { provider: "example-oauth", status: "ready" },
                { provider: "example-reauth", status: "auth-rejected" },
                {
                  provider: "example-mixed",
                  profileId: "example-mixed:api-key",
                  status: "auth-rejected",
                },
                { provider: "example-quota", status: "unavailable" },
                { provider: "example-rate", status: "unavailable" },
              ],
            },
            "usage.status": {
              updatedAt: now,
              providers: [
                {
                  provider: "example-quota",
                  displayName: "Example quota",
                  windows: [{ label: "Monthly quota", usedPercent: 100 }],
                },
                {
                  provider: "example-rate",
                  displayName: "Example rate limit",
                  windows: [],
                  error: "Temporary rate limit. Retry shortly.",
                },
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        for (const provider of providers) {
          const row = await expandProvider(page, provider.provider);
          if (recordVisuals) {
            const frame = await takeControlUiScreenshotFrame(
              page,
              row,
              [row.locator(".model-providers__profile-copy").first()],
              {
                animations: "disabled",
                elements: [row],
                scrollTo: row,
              },
            );
            await writeFile(
              path.join(suite.artifactDir, `${provider.provider}.png`),
              frame.elements[0]!.png,
            );
          }
        }
        const selected = page.locator('[data-provider-id="example-selected"]');
        expect((await selected.locator(".provider-row__status").textContent())?.trim()).toBe(
          "Expiring",
        );
        expect(
          await selected.locator('[data-profile-id="example-selected:excluded"]').textContent(),
        ).toContain("Sign in again");
        const mixed = page.locator('[data-provider-id="example-mixed"]');
        expect((await mixed.locator(".provider-row__status").textContent())?.trim()).toBe(
          "Credentials rejected",
        );
        const excluded = mixed.locator('[data-profile-id="example-mixed:excluded"]');
        expect(await excluded.textContent()).toContain("Sign-in unavailable");
        expect(await excluded.textContent()).not.toContain("Sign in again");
        const oauth = page.locator('[data-provider-id="example-oauth"]');
        expect((await oauth.locator(".provider-row__status").textContent())?.trim()).toBe("Ready");
        expect(await oauth.textContent()).toContain("Access token expires in 1h");
        expect(await oauth.textContent()).toContain(
          "Access-token expiry alone does not mean you need to sign in again.",
        );
        const reauth = page.locator('[data-provider-id="example-reauth"]');
        expect(await reauth.locator(".provider-row__status").textContent()).toContain(
          "Credentials rejected",
        );
        expect(
          await reauth.locator('[data-profile-id="example-reauth:account"]').textContent(),
        ).toContain("Sign-in unavailable");
        const quota = page.locator('[data-provider-id="example-quota"]');
        expect(await quota.textContent()).toContain("Monthly quota is used up");
        expect(await quota.textContent()).not.toContain("Sign in again");
        const rate = page.locator('[data-provider-id="example-rate"]');
        expect(await rate.textContent()).toContain("Temporary rate limit. Retry shortly.");
        expect(await rate.textContent()).not.toContain("Sign in again");
        expect(
          await page
            .locator('[data-provider-id="example-token"] .provider-row__status')
            .textContent(),
        ).toContain("Expired");
      },
    );
  });
});
