import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Check } from "typebox/value";
import { expect, it } from "vitest";
import { RecordOutput } from "../../../extensions/knowledge/src/inspection-contract.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Knowledge reader wording" });
suite.define(() => {
  it.each(["citations", "download", "save", "company", "identity-request"])(
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
          const company = scenario === "company" || scenario === "identity-request";
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
          } satisfies NonNullable<RecordOutput["record"]>;
          const candidate = {
            ...record,
            id: "atlas_company",
            title: "Atlas Robotics",
            metadata: {},
          };
          const actions: string[] = [];
          const offsets: unknown[] = [];
          await page.addInitScript((save) => {
            Object.defineProperty(window, "showSaveFilePicker", {
              configurable: true,
              value: save
                ? async () =>
                    (await navigator.storage.getDirectory()).getFileHandle("reader-source.txt", {
                      create: true,
                    })
                : undefined,
            });
          }, scenario === "save");
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
                  actions.push(action);
                  if (action === "record_detail") {
                    const offset =
                      typeof input.evidenceOffset === "number" ? input.evidenceOffset : 0;
                    offsets.push(input.evidenceOffset);
                    const result: RecordOutput = {
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
                    expect(Check(RecordOutput, result)).toBe(true);
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
                    attachment: {
                      filename: "reader-source.txt",
                      data: Buffer.from(source).toString("base64"),
                      offset: 0,
                      nextOffset: null,
                      sha256: hash,
                      size: Buffer.byteLength(source),
                    },
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
          const grid = page.locator(".knowledge-entity-grid");
          if (scenario === "citations") {
            await page.locator(".knowledge-source-group > summary").click();
            expect(await page.locator(".knowledge-evidence-list > p").textContent()).toBe(
              "25 citations · 1 file",
            );
            await page.getByRole("button", { name: "More citations", exact: true }).waitFor();
          } else if (company) {
            await page.getByText(/finds evidence they refer to the same subject/).waitFor();
          } else {
            const download = scenario === "download" ? page.waitForEvent("download") : undefined;
            await page.getByRole("button", { name: "Original file", exact: true }).click();
            if (download) {
              expect((await download).suggestedFilename()).toBe("reader-source.txt");
            }
            await page
              .getByText(scenario === "save" ? "Original file saved." : "Download requested.", {
                exact: true,
              })
              .waitFor();
            if (scenario === "save") {
              const saved = await page.evaluate(async () =>
                (
                  await (
                    await (
                      await navigator.storage.getDirectory()
                    ).getFileHandle("reader-source.txt")
                  ).getFile()
                ).text(),
              );
              expect(saved).toBe(source);
            }
          }
          if (scenario === "identity-request") {
            await page
              .locator(".knowledge-candidate")
              .getByRole("button", { name: /to check$/ })
              .click();
            expect(
              await page.getByRole("textbox", { name: "Request", exact: true }).inputValue(),
            ).toContain("refer to the same subject?");
          }
          if (process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR) {
            const target =
              scenario === "identity-request" ? page.locator(".knowledge-chat-handoff") : grid;
            const frame = await takeControlUiScreenshotFrame(page, target, [target], {
              animations: "disabled",
              elements: [target],
            });
            await writeFile(path.join(suite.artifactDir, scenario + "-full.png"), frame.png);
            await writeFile(
              path.join(suite.artifactDir, scenario + "-detail.png"),
              frame.elements[0]!.png,
            );
          }
          if (scenario === "identity-request") {
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
          expect(
            actions.every((action) =>
              [
                "stores_snapshot",
                "status",
                "ontology",
                "record_detail",
                "connections_detail",
                "timeline",
                "history",
                "attachment",
              ].includes(action),
            ),
          ).toBe(true);
        },
      );
    },
  );
});
