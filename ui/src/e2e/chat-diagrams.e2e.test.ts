import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { chatFixture, timedText } from "./chat-flow-fixtures.test-support.ts";
import { captureUiProofEnabled, createChatFlowE2eSuite } from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const flowchart = `flowchart LR
  accTitle: Request lifecycle
  accDescr: A request is approved before execution and its result is saved.
  G["Gateway: admit<br/>and approve"] --> W["Worker: execute<br/>the request"]
  W --> S[(Save result)]`;
const sequence = `sequenceDiagram
  participant Phone
  participant Gateway
  participant Worker
  Phone->>Gateway: Send request
  Gateway->>Worker: Approved
  Worker-->>Phone: Result ready`;

suite.define(() => {
  it.each([
    { name: "desktop-dark", width: 1440, height: 1000, mode: "dark", source: flowchart },
    { name: "mobile-light", width: 390, height: 844, mode: "light", source: sequence },
  ] as const)("keeps diagram, source and expanded image usable on $name", async (scenario) => {
    const { page } = await chatFixture(
      suite,
      {
        historyMessages: [
          timedText("user", "Show how an approved request reaches a worker."),
          timedText(
            "assistant",
            "The request follows this path.\n\n```mermaid\n" + scenario.source + "\n```",
          ),
        ],
      },
      { viewport: { width: scenario.width, height: scenario.height }, colorScheme: scenario.mode },
    );
    await page.goto(suite.server.baseUrl + "chat");
    const diagram = page.locator("openclaw-mermaid");
    const image = diagram.locator(".preview img");
    await image.waitFor({ timeout: 25_000 });
    await image.evaluate((element: HTMLImageElement) => element.decode());
    expect(
      await image.evaluate((element: HTMLImageElement) => element.naturalWidth),
    ).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    if (scenario.source === flowchart) {
      expect(await image.getAttribute("alt")).toBe("Request lifecycle");
    }
    if (captureUiProofEnabled) {
      const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [image], {
        animations: "disabled",
        scrollTo: image,
      });
      await writeFile(path.join(suite.artifactDir, `diagram-${scenario.name}.png`), frame.png);
    }

    await diagram.getByRole("button", { name: "Diagram options", exact: true }).click();
    await diagram.getByRole("menuitem", { name: "Show source", exact: true }).click();
    expect(await diagram.locator("code").textContent()).toContain(scenario.source);
    await diagram.getByRole("button", { name: "Diagram options", exact: true }).click();
    await diagram.getByRole("menuitem", { name: "Show diagram", exact: true }).click();
    await image.waitFor();
    await diagram.getByRole("button", { name: "Diagram options", exact: true }).click();
    await diagram.getByRole("menuitem", { name: "Expand diagram", exact: true }).click();
    const expanded = diagram.locator("openclaw-image-lightbox img");
    await expanded.waitFor();
    await expanded.evaluate((element: HTMLImageElement) => element.decode());
    expect(await expanded.getAttribute("src")).toBe(await image.getAttribute("src"));
  });
});
