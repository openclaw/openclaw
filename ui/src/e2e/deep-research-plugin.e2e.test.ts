import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect as pw } from "playwright/test";
import { expect, it } from "vitest";
import type { ResearchView } from "../../../extensions/deep-research/api.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Deep research native bundle" });
const sessionKey = "agent:main:dashboard:research-ui";
const method = (action: string) => `deep-research.view.v1.${action}`;
const timestamp = Date.parse("2026-01-01T12:00:00Z");
const id = "a".repeat(64);
const question = "How do urban trees reduce summer heat?";
const running: ResearchView = {
  version: 1,
  jobId: id,
  question,
  title: question,
  state: "running",
  phase: "gathering",
  summary: "Gathering evidence (round 1)",
  revision: "running",
  createdAt: timestamp,
  updatedAt: timestamp,
  cancelRequested: false,
  actions: ["cancel"],
  counts: { sources: 1, searches: 2, fetches: 1, modelCalls: 1 },
  sources: [
    {
      id: "S1",
      title: "Urban canopy study",
      url: "https://example.org/canopy",
      provenance: "retrieved-text",
      retrievalStatus: "retained",
      retrievedAt: "2026-01-01T12:00:00Z",
      excerpt: "Trees reduce heat through shade and evapotranspiration.",
    },
  ],
  findings: [],
  gaps: [],
  limitations: [],
  citations: [],
};
// Static transport fixture; producer UTF-8 ranges are qualified by plugin-owned tests.
const report = `# ${question}\n\nTrees cool streets through shade and evapotranspiration. [S1]`;
const startByte = new TextEncoder().encode(report.slice(0, report.indexOf("[S1]"))).byteLength;
const reportDocument = {
  report,
  citations: [{ sourceId: "S1", startByte, endByte: startByte + 4 }],
};
const partial: ResearchView = {
  ...running,
  state: "partial",
  phase: "partial",
  summary: "Report ready",
  revision: "partial",
  actions: [],
  report: reportDocument.report,
  citations: reportDocument.citations,
  findings: [
    {
      statement: "Trees cool streets through shade and evapotranspiration.",
      support: "model-supported",
      evidence: [{ sourceId: "S1", quote: running.sources[0]!.excerpt! }],
    },
  ],
  gaps: ["Cooling varies by climate and canopy coverage."],
  limitations: ["Model support is fallible and does not establish truth."],
};
const list = (job?: ResearchView) => ({
  version: 1,
  sessionId: "ui-generation",
  incarnation: "ui-incarnation",
  jobs: job ? [job] : [],
});
const read = (job: ResearchView) => ({
  version: 1,
  sessionId: "ui-generation",
  incarnation: "ui-incarnation",
  job,
});

suite.define(() => {
  it("opens native pane, safely navigates citations, handles cancellation/offline/reconnect and clears denied data", async () => {
    await suite.withPage(
      {
        viewport: { width: 1440, height: 1000 },
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        const gateway = await installMockGateway(page, {
          nativePlugins: [
            {
              pluginId: "deep-research",
              rootDir: resolve("extensions/deep-research"),
              source: "./browser/index.tsx",
            },
          ],
          communityInvite: false,
          assistantAgentId: "main",
          defaultAgentId: "main",
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            ...["list", "read", "start", "cancel", "resume"].map(method),
          ],
          methodResponses: {
            [method("list")]: list(),
            [method("read")]: read(running),
            [method("start")]: {
              __mockError: { code: "UNAVAILABLE", message: "Synthetic lost start reply" },
            },
            [method("cancel")]: read({ ...running, cancelRequested: true, actions: [] }),
          },
        });
        const capture = async (
          name: string,
          surface = page.locator("openclaw-app"),
          content = [surface],
        ) => {
          try {
            const frame = await takeControlUiScreenshotFrame(page, surface, content, {
              animations: "disabled",
              scrollTo: content[0],
            });
            writeFileSync(resolve(suite.artifactDir, `${name}.png`), frame.png);
          } catch (error) {
            await page.screenshot({ path: resolve(suite.artifactDir, `${name}-failure.png`) });
            writeFileSync(
              resolve(suite.artifactDir, `${name}-failure.json`),
              JSON.stringify(
                await Promise.all(
                  [surface, ...content].map((target) =>
                    target.evaluate((element) => {
                      const owners = [];
                      for (
                        let owner: Element | null = element;
                        owner;
                        owner = owner.parentElement
                      ) {
                        owners.push({
                          tag: owner.tagName,
                          className: owner.className,
                          bounds: owner.getBoundingClientRect().toJSON(),
                          scrollTop: owner.scrollTop,
                          scrollHeight: owner.scrollHeight,
                          overflow: getComputedStyle(owner).overflow,
                        });
                      }
                      return owners;
                    }),
                  ),
                ),
                null,
                2,
              ),
            );
            throw error;
          }
        };
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const open = page.getByRole("button", { name: "Open deep research progress" });
        await pw(open).toBeVisible();
        await capture("desktop-before", open);
        await page.setViewportSize({ width: 390, height: 844 });
        await capture("phone-before", open);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await open.click();
        const pane = page.locator(".deep-research-pane");
        await pw(pane).toBeVisible();
        try {
          await pw(
            pane.getByText("Start a question to build an evidence-backed report."),
          ).toBeVisible();
        } catch (error) {
          writeFileSync(
            resolve(suite.artifactDir, "native-mount.json"),
            JSON.stringify(
              await page.evaluate(() =>
                [...document.querySelectorAll("openclaw-plugin-view")].map((host) => ({
                  kind: Reflect.get(host, "kind"),
                  key: Reflect.get(host, "contributionKey"),
                  props: Reflect.get(host, "props"),
                  presented: Reflect.get(host, "presented"),
                  html: host.outerHTML,
                  parent: host.parentElement?.outerHTML.slice(0, 12000),
                })),
              ),
              null,
              2,
            ),
          );
          await capture("desktop-mount-failure");
          throw error;
        }
        await capture("desktop-empty", pane, [
          pane.getByRole("heading", { name: "Deep research" }),
        ]);
        // Exercise real native host/GatewayBrowserClient error framing, not a hand-built Error.
        await gateway.setMethodResponse(method("start"), {
          __mockError: {
            code: "INVALID_REQUEST",
            message: "Research rejected before acceptance",
            details: { code: "RESEARCH_START_REJECTED" },
          },
        });
        await pane.getByLabel("Research question").fill("A definitively rejected question");
        await pane.getByRole("button", { name: "Start research", exact: true }).click();
        await pw(pane.getByText("Research rejected before acceptance")).toBeVisible();
        await pw(pane.getByLabel("Research question")).toBeEnabled();
        await pw(pane.getByRole("button", { name: "Start research", exact: true })).toBeEnabled();
        await gateway.setMethodResponse(method("start"), {
          __mockError: { code: "UNAVAILABLE", message: "Synthetic lost start reply" },
        });
        await pane.getByLabel("Research question").fill(question);
        await pane.getByRole("button", { name: "Start research", exact: true }).click();
        await pw(
          pane.getByRole("button", { name: "Retry pending start", exact: true }),
        ).toBeVisible();
        await gateway.setMethodResponse(method("list"), list(running));
        await gateway.setMethodResponse(method("start"), read(running));
        await pane.getByRole("button", { name: "Retry pending start", exact: true }).click();
        await gateway.waitForRequest(method("start"), {
          match: { sessionKey, agentId: "main", request: { question } },
        });
        await pw(pane.getByText("Gathering evidence (round 1)")).toBeVisible();
        expect((await gateway.getRequests(method("start"))).length).toBe(3);
        const starts = await gateway.getRequests(method("start"));
        const startKeys = starts.map(({ params }) => {
          if (!params || typeof params !== "object" || !("idempotencyKey" in params)) {
            throw new Error("Native start request must carry its idempotency key");
          }
          expect(params).toMatchObject({
            incarnation: "ui-incarnation",
            idempotencyKey: expect.any(String),
          });
          return params.idempotencyKey;
        });
        expect(startKeys[1]).toBe(startKeys[2]);
        expect(startKeys[0]).not.toBe(startKeys[1]);
        await capture("desktop-running", pane, [pane.getByText("Gathering evidence (round 1)")]);
        await pane.getByRole("button", { name: "Cancel research", exact: true }).click();
        await gateway.waitForRequest(method("cancel"), {
          match: { jobId: id, sessionKey, agentId: "main" },
        });
        await gateway.setMethodResponse(
          method("read"),
          read({ ...running, cancelRequested: true, actions: [] }),
        );
        await gateway.emitGatewayEvent("plugin.deep-research.changed", {});
        await pw(
          pane.getByText("Cancellation requested · awaiting terminal observation"),
        ).toBeVisible();
        await gateway.setMethodResponse(method("read"), read(partial));
        await gateway.setMethodResponse(method("list"), list(partial));
        await gateway.emitGatewayEvent("plugin.deep-research.changed", {});
        await pane.getByRole("button", { name: "Report", exact: true }).click();
        const cite = pane.getByRole("button", { name: "Source S1", exact: true });
        await pw(cite).toBeVisible();
        await pw(pane.getByRole("heading", { name: question, exact: true })).toBeVisible();
        await pw(open).toContainText("1 source");
        await pw(open).not.toContainText("1 sources");
        await capture("desktop-report", pane, [cite]);
        await cite.click();
        await pw(pane.getByRole("region", { name: "Research sources" })).toBeVisible();
        await pw(pane.locator("details[open] summary")).toBeFocused();
        await pw(pane.getByText("Model-supported (fallible)", { exact: true })).toBeVisible();
        await pw(pane.getByRole("link", { name: "Open source in new tab ↗" })).toHaveAttribute(
          "rel",
          "noopener noreferrer",
        );
        await capture("desktop-source", pane, [pane.locator("details[open] summary")]);
        await pane.getByRole("button", { name: "Back to citation" }).click();
        await pw(cite).toBeFocused();
        // Actual host responsive panel geometry, same built plugin bytes.
        await page.setViewportSize({ width: 390, height: 844 });
        await capture("phone-portrait-report", pane, [cite]);
        await page.setViewportSize({ width: 844, height: 390 });
        await pane.getByRole("button", { name: "Sources (1)", exact: true }).click();
        await capture("phone-landscape-source", pane, [pane.locator("details[open] summary")]);
        expect(await pane.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await gateway.setOnline(false);
        // The native host retires plugin authority on disconnect, including the pane body.
        const unavailable = page.getByText(
          "The plugin that owns this tab is not active on the connected gateway, or it did not provide a panel.",
          { exact: true },
        );
        await pw(unavailable).toBeVisible();
        await pw(pane).toHaveCount(0);
        await capture("desktop-offline", page.locator("openclaw-app"), [unavailable]);
        await gateway.setOnline(true);
        await pw(pane).toBeVisible();
        await pw(pane.getByText("Report ready", { exact: true })).toBeVisible();
        await pw(unavailable).toBeHidden();
        expect((await gateway.getRequests(method("start"))).length).toBe(3);
        await gateway.setMethodResponse(
          method("list"),
          list({ ...running, state: "indeterminate", phase: "indeterminate", actions: [] }),
        );
        await gateway.setMethodResponse(
          method("read"),
          read({
            ...running,
            state: "indeterminate",
            phase: "indeterminate",
            summary: "Submission outcome unknown; not resubmitted.",
            actions: [],
          }),
        );
        await gateway.emitGatewayEvent("plugin.deep-research.changed", {});
        await pane.getByRole("button", { name: "Progress", exact: true }).click();
        await pw(
          pane.getByText(
            "An operation may have been submitted without a receipt. It will not be blindly restarted.",
          ),
        ).toBeVisible();
        await capture("desktop-indeterminate", pane, [
          pane.getByText("Submission outcome unknown; not resubmitted."),
        ]);
        await gateway.setMethodResponse(method("list"), {
          __mockError: { code: "FORBIDDEN", message: "Session access denied" },
        });
        await gateway.emitGatewayEvent("plugin.deep-research.changed", {});
        await pw(pane.getByText(question, { exact: true })).toHaveCount(0);
        await capture("desktop-denied", pane, [pane.getByRole("alert")]);
        expect(errors).toEqual([]);
        writeFileSync(
          resolve(suite.artifactDir, "assets.json"),
          JSON.stringify(
            await page.evaluate(() =>
              performance
                .getEntriesByType("resource")
                .map((entry) => entry.name)
                .filter((url) => url.includes("/plugins/control-ui/")),
            ),
            null,
            2,
          ),
        );
        writeFileSync(
          resolve(suite.artifactDir, "requests.json"),
          JSON.stringify(await gateway.getRequests(), null, 2),
        );
      },
    );
  }, 120_000);
});
