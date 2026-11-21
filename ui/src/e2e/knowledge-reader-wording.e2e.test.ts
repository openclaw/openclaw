import { createHash } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Knowledge reader wording" });
suite.define(() => {
  it.each(["citations", "identity-request"])(
    "describes the %s outcome accurately",
    async (scenario) => {
      await suite.withPage(
        {
          viewport: { width: 1280, height: 1100 },
          colorScheme: "light",
          locale: "en-US",
          reducedMotion: "reduce",
        },
        async ({ page }) => {
          const source = Array.from(
            { length: 25 },
            (_, index) => "Rollout note " + (index + 1) + ": Atlas will evaluate the pilot.",
          ).join("\n");
          const hash = createHash("sha256").update(source).digest("hex");
          const company = scenario === "identity-request";
          const total = scenario === "citations" ? 25 : 1;
          const record = {
            id: "reader_record",
            title: company ? "Atlas Automation" : "Atlas pilot plan",
            kind: company ? "page" : "claim",
            type: company ? "company" : "fact",
            path: "records/reader.md",
            revision: 1,
            lifecycle: "active",
            valid: true,
            hash: "a".repeat(64),
            body: company
              ? "A company being considered for the pilot."
              : "Atlas plans a three-week pilot.",
            claimKind: "fact",
            assertionOrigin: "source",
            metadata: company
              ? {
                  identity: {
                    status: "partial",
                    context: "Possible company rename",
                    candidates: [
                      { id: "atlas_company", basis: "The source uses both company names." },
                    ],
                  },
                }
              : { claim_kind: "fact" },
          };
          const candidate = {
            ...record,
            id: "atlas_company",
            title: "Atlas Robotics",
            metadata: {},
          };
          const offsets: unknown[] = [];
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
                    action = requireString(request.actionId, "action"),
                    input = requireRecord(request.payload);
                  if (action === "record_detail") {
                    const offset =
                      typeof input.evidenceOffset === "number" ? input.evidenceOffset : 0;
                    offsets.push(input.evidenceOffset);
                    const result = {
                      view: "content",
                      record,
                      content: { offset: 0, totalChars: record.body.length, nextOffset: null },
                      issues: [],
                      references: company ? [candidate] : [],
                      evidenceTotal: company ? 0 : total,
                      evidenceSourceTotal: company ? 0 : 1,
                      nextEvidenceOffset: total > offset + 20 ? offset + 20 : null,
                      evidence: company
                        ? []
                        : Array.from({ length: Math.min(20, total - offset) }, (_, index) => ({
                            path: "artifacts/reader-source.txt",
                            filename: "reader-source.txt",
                            sha256: hash,
                            mediaType: "text/plain",
                            size: Buffer.byteLength(source),
                            start_line: offset + index + 1,
                            end_line: offset + index + 1,
                            attribution: "Pilot planning notes",
                            excerpt: source.split("\n")[offset + index]!,
                            verified: true,
                            excerptTruncated: false,
                          })),
                    };
                    return { ok: true, result };
                  }
                  const answers: Record<string, unknown> = {
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
                    throw new Error("Unexpected reader action: " + action);
                  }
                  return { ok: true, result: answers[action] };
                },
              },
            },
          );
          await page.goto(
            new URL(
              "/plugin?plugin=knowledge&id=overview&p.record=reader_record",
              suite.server.baseUrl,
            ).toString(),
          );
          await page.getByRole("heading", { name: record.title, exact: true }).waitFor();
          await page.getByText("No connections recorded.", { exact: true }).waitFor();
          if (scenario === "citations") {
            await page.locator(".knowledge-source-group > summary").click();
            expect(await page.locator(".knowledge-evidence-list > p").textContent()).toBe(
              "25 citations · 1 file",
            );
            await page.getByRole("button", { name: "More citations", exact: true }).waitFor();
          } else {
            await page.getByText(/finds evidence they refer to the same subject/).waitFor();
          }
          if (scenario === "identity-request") {
            await page
              .locator(".knowledge-candidate")
              .getByRole("button", { name: /to check$/ })
              .click();
            expect(
              await page.getByRole("textbox", { name: "Request", exact: true }).inputValue(),
            ).toContain("refer to the same subject?");
            await page.getByRole("button", { name: "Cancel", exact: true }).click();
          }
          if (scenario === "citations") {
            await page.getByRole("button", { name: "More citations", exact: true }).click();
            await expect
              .poll(() => page.locator(".knowledge-source-group > summary").textContent())
              .toContain("25 citations");
            expect(await page.locator(".knowledge-source-group").count()).toBe(1);
            expect(offsets).toContain(20);
          }
        },
      );
    },
  );
});
