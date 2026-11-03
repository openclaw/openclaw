import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { computeBaseConfigSchemaResponse } from "../../../src/config/schema-base.ts";
import { asSchemaObject } from "../../../src/config/schema.shared.ts";
import { takeControlUiElementScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  configProof,
  configSnapshot,
  createConfigSuite,
  objectSchema,
  settingsPageOptions,
} from "./config-composer-fixtures.test-support.ts";

const suite = createConfigSuite("Attachment limit settings");
const proof = configProof("attachment-limits");

suite.define(() => {
  it("renders independent limits and saves the exact per-file and message settings", async () => {
    const response = computeBaseConfigSchemaResponse();
    const attachments = asSchemaObject(asSchemaObject(response.schema)?.properties?.attachments);
    if (!attachments?.properties) {
      throw new Error("Attachment configuration schema missing");
    }
    for (const stage of ["before", "after"] as const) {
      await suite.withPage(settingsPageOptions, async ({ page }) => {
        const schema =
          stage === "before"
            ? { ...attachments, properties: { ttlHours: attachments.properties?.ttlHours } }
            : attachments;
        const config = {
          attachments: {
            ttlHours: 24,
            ...(stage === "after" ? { maxFileMb: 10, maxTotalMb: 15 } : {}),
          },
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configSnapshot(config, "attachment-settings", true),
            "config.schema": {
              ...response,
              schema: objectSchema("", { attachments: schema }),
              uiHints:
                stage === "before"
                  ? {
                      ...response.uiHints,
                      attachments: {
                        ...response.uiHints.attachments,
                        help: "Top-level retention behavior shared across providers and tools that persist media. Use ttlHours when general staged media needs bounded cleanup.",
                      },
                    }
                  : response.uiHints,
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/advanced?section=attachments&advanced=1`);
        const section = page.locator("#config-section-attachments");
        await section.waitFor();
        const ttl = page.getByRole("spinbutton", {
          name: "Attachment Retention TTL (hours)",
          exact: true,
        });
        await expect.poll(() => ttl.inputValue()).toBe("24");
        if (stage === "after") {
          const file = page.getByRole("spinbutton", {
            name: "Maximum attachment size",
            exact: true,
          });
          const total = page.getByRole("spinbutton", {
            name: "Maximum total attachment size per message",
            exact: true,
          });
          await expect.poll(() => file.inputValue()).toBe("10");
          await expect.poll(() => total.inputValue()).toBe("15");
          expect(await section.textContent()).toContain("MiB");
          if (proof.enabled) {
            await writeFile(
              path.join(proof.directory(), "after.png"),
              await takeControlUiElementScreenshot(page, section, [file, total, ttl]),
            );
          }
          await file.fill("12");
          await total.fill("18");
          const request = await gateway.waitForRequest("config.set");
          await expect
            .poll(async () => {
              const requests = await gateway.getRequests("config.set");
              const last = requests.at(-1) ?? request;
              const params = last.params as { raw: string };
              return JSON.parse(params.raw).attachments;
            })
            .toEqual({ ttlHours: 24, maxFileMb: 12, maxTotalMb: 18 });
        } else {
          expect(
            await page
              .getByRole("spinbutton", { name: "Maximum attachment size", exact: true })
              .count(),
          ).toBe(0);
          if (proof.enabled) {
            await writeFile(
              path.join(proof.directory(), "before.png"),
              await takeControlUiElementScreenshot(page, section, [ttl]),
            );
          }
        }
      });
    }
  });
});
