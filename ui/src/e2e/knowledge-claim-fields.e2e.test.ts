import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { rasterizeProofAnnotations } from "../test-helpers/proof-annotations.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Knowledge claim fields" });
suite.define(() => {
  it("shows a claim's takeaway, event span and inference provenance", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        colorScheme: "light",
        locale: "en-US",
        timezoneId: "UTC",
        reducedMotion: "reduce",
      },
      async ({ page }) => {
        const source = "Alex: We chose option B because it ships by Friday.";
        const record = {
          id: "atom_claim_1",
          title: "Option B story angle",
          kind: "claim",
          type: "event",
          path: "claims/option-b-story-angle.md",
          revision: 1,
          lifecycle: "active",
          valid: true,
          hash: "b".repeat(64),
          body: "Alex chose option B over the incumbent vendor.",
          claimKind: "event",
          assertionOrigin: "agent_inference",
          attribution: "Extracted from the planning meeting transcript",
          metadata: {
            claim_kind: "event",
            assertion_origin: "agent_inference",
            attribution: "Extracted from the planning meeting transcript",
            occurred_at: "2026-09-20",
            occurred_until: "2026-09-23",
            takeaway: "Teams pick the option they can ship by Friday.",
            tags: ["story_angle"],
            inferred_by: { agent: "atom-extractor", at: "2026-10-01", confidence: "medium" },
          },
        };
        await installNativePluginMockGateway(
          page,
          {
            nativePlugins: [
              {
                pluginId: "knowledge",
                rootDir: path.resolve("extensions/knowledge"),
                source: "./src/control-ui.ts",
              },
            ],
            methodResponses: { "cron.list": { jobs: [] } },
          },
          {
            requestHandlers: {
              "plugins.sessionAction": (params) => {
                const request = requireRecord(params),
                  action = requireString(request.actionId, "action");
                const answers: Record<string, unknown> = {
                  record_detail: {
                    view: "content",
                    record,
                    content: { offset: 0, totalChars: record.body.length, nextOffset: null },
                    issues: [],
                    references: [],
                    evidenceTotal: 1,
                    evidenceSourceTotal: 1,
                    nextEvidenceOffset: null,
                    evidence: [
                      {
                        path: "artifacts/planning-meeting.txt",
                        filename: "planning-meeting.txt",
                        sha256: createHash("sha256").update(source).digest("hex"),
                        mediaType: "text/plain",
                        size: Buffer.byteLength(source),
                        start_line: 1,
                        end_line: 1,
                        quote: "We chose option B",
                        attribution: "Planning meeting transcript",
                        excerpt: source,
                        verified: true,
                        excerptTruncated: false,
                      },
                    ],
                  },
                  stores_snapshot: { defaultAgent: "main", agents: [], stores: [] },
                  status: {
                    agent: "main",
                    vault: "fixture-vault",
                    scope: "private",
                    store: "ready",
                    snapshot: "s1",
                  },
                  ontology: { view: "catalog", nextOffset: null, definitions: [] },
                  connections_detail: { connections: [], nextOffset: null, snapshot: "s1" },
                  timeline: { items: [], nextOffset: null, snapshot: "s1" },
                  history: { mutations: [], entries: [], nextOffset: null },
                };
                if (!(action in answers)) {
                  throw new Error("Unexpected claim action: " + action);
                }
                return { ok: true, result: answers[action] };
              },
            },
          },
        );
        await page.goto(
          new URL(
            "/plugin?plugin=knowledge&id=overview&p.agent=main&p.vault=fixture-vault&p.record=atom_claim_1",
            suite.server.baseUrl,
          ).toString(),
        );
        await page.getByRole("heading", { name: record.title, exact: true }).waitFor();
        const header = page.locator(".knowledge-entity-header");
        const statement = page.locator(".knowledge-statement");
        await statement.locator(".knowledge-claim-details").waitFor();
        // Capture before asserting, so the same frame also records the base revision's rendering.
        // These regions exist on both revisions; the new fields render inside them.
        const regions = [
          { target: header.locator(".knowledge-occurred"), text: "Occurrence" },
          { target: statement.locator(".knowledge-claim-copy"), text: "Claim summary" },
          { target: statement.locator(".knowledge-claim-details"), text: "Claim details" },
        ];
        const frame = await takeControlUiScreenshotFrame(page, page.locator("body"), [header], {
          elements: regions.map((region) => region.target),
          animations: "disabled",
        });
        const annotationFrame = {
          viewport: page.viewportSize()!,
          scale: await page.evaluate(() => window.devicePixelRatio),
          annotations: regions.map((region, index) => {
            const rect = frame.elements[index]!.bounds;
            return {
              kind: "outline" as const,
              rect,
              text: region.text,
              labelAt: { x: 600, y: rect.y + rect.height / 2 },
              color: "#C2410C",
            };
          }),
        };
        await writeFile(path.join(suite.artifactDir, "claim-fields-clean.png"), frame.png);
        await writeFile(
          path.join(suite.artifactDir, "claim-fields-annotations.json"),
          JSON.stringify(annotationFrame, null, 2),
        );
        await writeFile(
          path.join(suite.artifactDir, "claim-fields-annotated.png"),
          await rasterizeProofAnnotations(suite.browser, { ...annotationFrame, image: frame.png }),
        );
        await statement
          .getByText("Takeaway: Teams pick the option they can ship by Friday.", { exact: true })
          .waitFor();
        expect(await header.locator(".knowledge-occurred").textContent()).toBe(
          "Occurred Sep 20, 2026 – Sep 23, 2026",
        );
        await statement
          .getByText("atom-extractor · Oct 1, 2026 · medium confidence", { exact: true })
          .waitFor();
      },
    );
  });
});
