// Control UI proof keeps ClawHub skill artwork inside the production Gateway CSP.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildControlUiCspHeader,
  computeInlineScriptHashes,
} from "../../../src/gateway/control-ui-csp.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const registryIconScenarios = [
  {
    label: "the default registry",
    skillIconUrl: `https://clawhub.ai/api/v1/skill-icons/${"a".repeat(64)}`,
    detailIconUrl: `https://clawhub.ai/api/v1/skill-icons/${"b".repeat(64)}`,
  },
  {
    label: "a path-mounted registry",
    skillIconUrl: `https://registry.example.test/clawhub/api/v1/skill-icons/${"a".repeat(64)}`,
    detailIconUrl: `https://registry.example.test/clawhub/api/v1/skill-icons/${"b".repeat(64)}`,
  },
] as const;
const skillIconPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4n8/wHwAGTQJu5DkvqwAAAABJRU5ErkJggg==",
  "base64",
);

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI ClawHub skill icons", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each(registryIconScenarios)(
    "loads search and detail artwork from $label through the authenticated proxy under production CSP",
    async ({ skillIconUrl, detailIconUrl }) => {
      const context = await browser.newContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
      });

      try {
        await context.addInitScript(() => {
          const violations: Array<{ blockedUri: string; effectiveDirective: string }> = [];
          Object.assign(globalThis, { __openclawClawHubIconCspViolations: violations });
          document.addEventListener("securitypolicyviolation", (event) => {
            violations.push({
              blockedUri: event.blockedURI,
              effectiveDirective: event.effectiveDirective,
            });
          });
        });

        const page = await context.newPage();
        await page.addInitScript(
          ({ gatewayUrl }) => {
            window["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl };
          },
          { gatewayUrl: server.baseUrl.replace(/^http/u, "ws") },
        );
        const directImageRequests: string[] = [];
        const proxiedImageRequests: Array<{ authorization: string; sourceUrl: string }> = [];
        page.on("request", (request) => {
          if (request.url().startsWith(`${new URL(skillIconUrl).origin}/`)) {
            directImageRequests.push(request.url());
          }
        });

        const gateway = await installMockGateway(page, {
          featureMethods: ["skills.status", "skills.search", "skills.detail"],
          methodResponses: {
            "skills.status": {
              workspaceDir: "/tmp/openclaw-e2e/workspace",
              managedSkillsDir: "/tmp/openclaw-e2e/skills",
              skills: [],
            },
            "skills.search": {
              results: [
                {
                  score: 1,
                  slug: "github",
                  displayName: "GitHub",
                  summary: "GitHub integration for OpenClaw",
                  icon: skillIconUrl,
                  version: "1.2.3",
                },
              ],
            },
            "skills.detail": {
              skill: {
                slug: "github",
                displayName: "GitHub",
                summary: "GitHub integration for OpenClaw",
                icon: detailIconUrl,
                createdAt: 1_700_000_000,
                updatedAt: 1_700_000_100,
              },
              owner: {
                displayName: "OpenClaw",
                handle: "openclaw",
                image: "https://attacker.example/profile.png",
              },
            },
          },
        });

        await page.route("**/__openclaw__/catalog-icon/**", async (route) => {
          const request = route.request();
          const encodedSourceUrl = new URL(request.url()).pathname.split("/").at(-1) ?? "";
          proxiedImageRequests.push({
            authorization: request.headers().authorization ?? "",
            sourceUrl: decodeURIComponent(encodedSourceUrl),
          });
          await route.fulfill({
            body: skillIconPng,
            contentType: "image/png",
            status: 200,
          });
        });

        const skillsUrl = `${server.baseUrl}skills`;
        await page.route(skillsUrl, async (route) => {
          const response = await route.fetch();
          const body = await response.text();
          await route.fulfill({
            body,
            headers: {
              ...response.headers(),
              "content-security-policy": buildControlUiCspHeader({
                inlineScriptHashes: computeInlineScriptHashes(body),
              }),
            },
            response,
          });
        });

        const response = await page.goto(skillsUrl);
        expect(response?.status()).toBe(200);
        expect(response?.headers()["content-security-policy"]).toContain(
          "img-src 'self' data: blob: https://gravatar.com",
        );
        await gateway.waitForRequest("skills.status");
        await page.getByPlaceholder("Search ClawHub skills…").fill("github");
        await gateway.waitForRequest("skills.search");

        const searchIcon = page.locator(".plugins-item .clawhub-skill-icon");
        await expect.poll(async () => await searchIcon.count()).toBe(1);
        await expect
          .poll(
            async () => await searchIcon.evaluate((image: HTMLImageElement) => image.naturalWidth),
          )
          .toBeGreaterThan(0);
        expect(await searchIcon.getAttribute("src")).toMatch(/^blob:/u);

        await page.getByRole("button", { name: "Open GitHub details" }).click();
        await gateway.waitForRequest("skills.detail");
        const detailIcon = page.locator(".clawhub-skill-icon--detail");
        await expect.poll(async () => await detailIcon.count()).toBe(1);
        await expect
          .poll(
            async () => await detailIcon.evaluate((image: HTMLImageElement) => image.naturalWidth),
          )
          .toBeGreaterThan(0);
        expect(await detailIcon.getAttribute("src")).toMatch(/^blob:/u);

        expect(proxiedImageRequests).toEqual([
          { authorization: "Bearer e2e-device-token", sourceUrl: skillIconUrl },
          { authorization: "Bearer e2e-device-token", sourceUrl: detailIconUrl },
        ]);
        expect(directImageRequests).toEqual([]);
        expect(await page.locator('img[src^="https:"]').count()).toBe(0);
        expect(
          await page.evaluate(() => {
            const runtime = globalThis as typeof globalThis & {
              __openclawClawHubIconCspViolations?: Array<{
                blockedUri: string;
                effectiveDirective: string;
              }>;
            };
            return (runtime["__openclawClawHubIconCspViolations"] ?? []).filter((violation) =>
              violation.effectiveDirective.startsWith("img-src"),
            );
          }),
        ).toEqual([]);
      } finally {
        await context.close();
      }
    },
  );
});
