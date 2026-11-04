import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

export const readStyles = (...names: string[]) =>
  names.map((name) => readStyleSheet(`ui/src/${name}.css`)).join("\n");

export function styleDocument(css: string, body: string, attributes = "") {
  return `<!doctype html><html ${attributes}><head><style>${css}</style></head><body>${body}</body></html>`;
}

export async function traceCss(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  const recalculated: number[] = [];
  cdp.on("Tracing.dataCollected", ({ value }) => {
    for (const event of value) {
      const args = event.args;
      if (
        event.name === "UpdateLayoutTree" &&
        isRecord(args) &&
        typeof args.elementCount === "number"
      ) {
        recalculated.push(args.elementCount);
      }
    }
  });
  await cdp.send("Tracing.start", {
    categories: "devtools.timeline",
    transferMode: "ReportEvents",
  });
  return async () => {
    const completed = new Promise<void>((resolve) => {
      cdp.once("Tracing.tracingComplete", () => resolve());
    });
    await cdp.send("Tracing.end");
    await completed;
    await cdp.detach();
    return recalculated;
  };
}

// Each calling test file owns one browser and, if needed, one canonical temp directory.
export function styleFixture(prefix: string, { required = false, ignoreCloseErrors = false } = {}) {
  const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  const available = canRunPlaywrightChromium(executablePath);
  let browser: Browser;
  let directory: string | undefined;
  const close = async (resource: Browser | Page | undefined) => {
    const closing = resource?.close();
    await (ignoreCloseErrors ? closing?.catch(() => {}) : closing);
  };
  beforeAll(async () => {
    if (required) {
      expect(available, "Chromium is required for paint proof").toBe(true);
    }
    if (available) {
      browser = await chromium.launch({ executablePath, headless: true });
    }
  });
  afterAll(async () => {
    await close(browser);
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  const file = (name: string, html: string) => {
    directory ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    const target = path.join(directory, `${name}.html`);
    fs.writeFileSync(target, html, "utf8");
    return target;
  };
  return {
    executablePath,
    available,
    describe: required || available ? describe : describe.skip,
    page: (options?: Parameters<Browser["newPage"]>[0]) => browser.newPage(options),
    async withPage<T>(name: string, html: string, run: (page: Page) => Promise<T>): Promise<T> {
      const page = await browser.newPage();
      try {
        await page.goto(`file://${file(name, html)}`);
        return await run(page);
      } finally {
        await close(page);
      }
    },
  };
}
