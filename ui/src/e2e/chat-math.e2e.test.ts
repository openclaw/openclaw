import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "chat math rendering" });
const text =
  String.raw`Inline \(x_i^2\), prices $5 and $10.

\[
\begin{aligned}
G_{\mathrm{eff}} &> G \\
\Delta\Gamma &= \frac{d\ln M_{\rm MG}}{d\ln a} - \frac{d\ln M_{\rm GR}}{d\ln a}
\end{aligned}
\]

$$E = mc^2$$

Code: ` +
  "`\\(literal\\)`" +
  '\n\n```python\nformula = "$$x^2$$"\n```';

suite.define(() => {
  it("renders math in chat history with fonts while preserving code and currency", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1180, height: 900 } },
      async ({ page }) => {
        await installMockGateway(page, {
          agentModel: "openai/gpt-4.1",
          models: [{ id: "gpt-4.1", name: "GPT-4.1", provider: "openai" }],
          historyMessages: [{ role: "assistant", content: [{ type: "text", text }], timestamp: 0 }],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const equations = page.locator(".markdown-math");
        await expect.poll(() => equations.count()).toBe(3);
        await expect
          .poll(() =>
            equations.evaluateAll((nodes) =>
              nodes.every((node) => node.firstElementChild?.shadowRoot?.querySelector(".katex")),
            ),
          )
          .toBe(true);
        await page.evaluate(() => document.fonts.ready);
        expect(
          await page.evaluate(() =>
            [...document.fonts].some(
              (font) => font.family === "KaTeX_Main" && font.status === "loaded",
            ),
          ),
        ).toBe(true);
        await expect
          .poll(() => page.getByText("prices $5 and $10.", { exact: false }).count())
          .toBeGreaterThan(0);
        expect(await page.locator("code").allTextContents()).toContain("\\(literal\\)");
        expect((await page.locator("pre").allTextContents()).join("\n")).toContain(
          'formula = "$$x^2$$"',
        );
        if (process.env.OPENCLAW_MATH_CAPTURE) {
          const chat = page.locator("section.chat");
          const frame = await takeControlUiScreenshotFrame(page, chat, [equations.first()], {
            animations: "disabled",
            elements: [chat],
          });
          writeFileSync(path.join(suite.artifactDir, "math-after.png"), frame.elements[0]!.png);
        }
        await equations.first().evaluate((host) => {
          const source = [...host.firstElementChild!.childNodes].find(
            (node) => node.nodeType === Node.TEXT_NODE,
          );
          if (!source) {
            throw new Error("Missing equation source");
          }
          source.textContent = "z^3";
          host.classList.add("markdown-math-display");
        });
        await expect
          .poll(() =>
            equations
              .first()
              .evaluate(
                (host) =>
                  host.firstElementChild?.shadowRoot?.querySelector("annotation")?.textContent,
              ),
          )
          .toBe("z^3");
        expect(
          await equations
            .first()
            .evaluate((host) =>
              Boolean(host.firstElementChild?.shadowRoot?.querySelector(".katex-display")),
            ),
        ).toBe(true);
      },
    );
  });
});
