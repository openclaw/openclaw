// Real first-run route and styles; detection/catalog replies are synthetic.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  candidate,
  expectRequestCounts,
  localPrepareOptions,
  makeDetection,
  setupRpc as rpc,
} from "./model-setup-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "First-run model section headings" });
const scenarios = [
  makeDetection({
    candidates: [candidate("codex-cli", "Codex", "openai/gpt-5")],
    authOptions: [{ id: "provider-login", label: "Provider login", kind: "oauth", featured: true }],
    prepareOptions: localPrepareOptions(),
    manualProviders: [{ id: "openai", label: "OpenAI" }],
    nativeSessionCatalogs: [{ pluginId: "codex", label: "Codex" }],
    nativeSessionCatalogPreferenceRequired: true,
  }),
  makeDetection({
    recommendedInstalls: [
      {
        id: "ollama",
        label: "Ollama",
        hint: "Run models locally",
        website: "https://ollama.com",
        icon: "https://example.test/ollama.svg",
      },
    ],
  }),
];

suite.define(() => {
  it.each(scenarios)("keeps first-run section copy aligned with its body %#", async (detection) => {
    await suite.withPage({ viewport: { width: 1400, height: 1000 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        models: [],
        featureMethods: [rpc.detect, rpc.prepare, rpc.auth, rpc.activate, "models.list"],
        methodResponses: { [rpc.detect]: detection },
      });
      await page.goto(`${suite.server.baseUrl}settings/model-setup?firstRun=1`);
      await page.locator(".model-setup__manual").waitFor();
      for (const width of [1400, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(() => document.fonts.ready);
        const headings = await page
          .locator(".model-setup .settings-section")
          .evaluateAll((sections) =>
            sections.map((section) => {
              const heading = section.querySelector("h2")!;
              const header = heading.closest(".settings-section__header")!;
              const description = header.querySelector("p");
              const bounds = heading.getBoundingClientRect();
              return {
                title: heading.textContent,
                left: bounds.left - section.getBoundingClientRect().left,
                margin: getComputedStyle(heading).margin,
                descriptionBelow:
                  !description || description.getBoundingClientRect().top >= bounds.bottom,
                overflow: header.scrollWidth > header.clientWidth,
              };
            }),
          );
        expect(headings.length).toBe(detection.candidates.length ? 6 : 3);
        for (const heading of headings) {
          expect(heading.left, heading.title ?? "heading").toBeCloseTo(0, 0);
          expect(heading.margin).toBe("0px");
          expect(heading.descriptionBelow).toBe(true);
          expect(heading.overflow).toBe(false);
        }
      }
      await expectRequestCounts(gateway, {
        [rpc.activate]: 0,
        [rpc.auth]: 0,
        [rpc.prepare]: 0,
        [rpc.verify]: 0,
        "agents.update": 0,
        "config.patch": 0,
      });
    });
  });
});
