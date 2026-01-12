import type { BrowserFormField } from "./client-actions-core.js";
import {
  type BrowserConsoleMessage,
  ensurePageState,
  getPageForTargetId,
  refLocator,
  type WithSnapshotForAI,
} from "./pw-session.js";

let nextUploadArmId = 0;
let nextDialogArmId = 0;

function requireRef(value: unknown): string {
  const ref = typeof value === "string" ? value.trim() : "";
  if (!ref) throw new Error("ref is required");
  return ref;
}

export async function snapshotAiViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timeoutMs?: number;
  maxChars?: number;
}): Promise<{ snapshot: string; truncated?: boolean }> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);

  const maybe = page as unknown as WithSnapshotForAI;
  if (!maybe._snapshotForAI) {
    throw new Error(
      "Playwright _snapshotForAI is not available. Upgrade playwright-core.",
    );
  }

  const result = await maybe._snapshotForAI({
    timeout: Math.max(
      500,
      Math.min(60_000, Math.floor(opts.timeoutMs ?? 5000)),
    ),
    track: "response",
  });
  let snapshot = String(result?.full ?? "");
  const maxChars = opts.maxChars;
  const limit =
    typeof maxChars === "number" && Number.isFinite(maxChars) && maxChars > 0
      ? Math.floor(maxChars)
      : undefined;
  if (limit && snapshot.length > limit) {
    snapshot = `${snapshot.slice(0, limit)}\n\n[...TRUNCATED - page too large]`;
    return { snapshot, truncated: true };
  }
  return { snapshot };
}

export async function clickViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
  modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
  });
  ensurePageState(page);
  const locator = refLocator(page, requireRef(opts.ref));
  const timeout = Math.max(
    500,
    Math.min(60_000, Math.floor(opts.timeoutMs ?? 8000)),
  );
  if (opts.doubleClick) {
    await locator.dblclick({
      timeout,
      button: opts.button,
      modifiers: opts.modifiers,
    });
  } else {
    await locator.click({
      timeout,
      button: opts.button,
      modifiers: opts.modifiers,
    });
  }
}

export async function hoverViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  timeoutMs?: number;
}): Promise<void> {
  const ref = String(opts.ref ?? "").trim();
  if (!ref) throw new Error("ref is required");
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await refLocator(page, ref).hover({
    timeout: Math.max(500, Math.min(60_000, opts.timeoutMs ?? 8000)),
  });
}

export async function dragViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  startRef: string;
  endRef: string;
  timeoutMs?: number;
}): Promise<void> {
  const startRef = String(opts.startRef ?? "").trim();
  const endRef = String(opts.endRef ?? "").trim();
  if (!startRef || !endRef) throw new Error("startRef and endRef are required");
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await refLocator(page, startRef).dragTo(refLocator(page, endRef), {
    timeout: Math.max(500, Math.min(60_000, opts.timeoutMs ?? 8000)),
  });
}

export async function selectOptionViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  values: string[];
  timeoutMs?: number;
}): Promise<void> {
  const ref = String(opts.ref ?? "").trim();
  if (!ref) throw new Error("ref is required");
  if (!opts.values?.length) throw new Error("values are required");
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await refLocator(page, ref).selectOption(opts.values, {
    timeout: Math.max(500, Math.min(60_000, opts.timeoutMs ?? 8000)),
  });
}

export async function pressKeyViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  key: string;
  delayMs?: number;
}): Promise<void> {
  const key = String(opts.key ?? "").trim();
  if (!key) throw new Error("key is required");
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.keyboard.press(key, {
    delay: Math.max(0, Math.floor(opts.delayMs ?? 0)),
  });
}

export async function typeViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  text: string;
  submit?: boolean;
  slowly?: boolean;
  timeoutMs?: number;
}): Promise<void> {
  const text = String(opts.text ?? "");
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const locator = refLocator(page, requireRef(opts.ref));
  const timeout = Math.max(500, Math.min(60_000, opts.timeoutMs ?? 8000));
  if (opts.slowly) {
    await locator.click({ timeout });
    await locator.type(text, { timeout, delay: 75 });
  } else {
    await locator.fill(text, { timeout });
  }
  if (opts.submit) {
    await locator.press("Enter", { timeout });
  }
}

export async function fillFormViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  fields: BrowserFormField[];
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  for (const field of opts.fields) {
    const ref = field.ref.trim();
    const type = field.type.trim();
    const rawValue = field.value;
    const value =
      typeof rawValue === "string"
        ? rawValue
        : typeof rawValue === "number" || typeof rawValue === "boolean"
          ? String(rawValue)
          : "";
    if (!ref || !type) continue;
    const locator = refLocator(page, ref);
    if (type === "checkbox" || type === "radio") {
      const checked =
        rawValue === true ||
        rawValue === 1 ||
        rawValue === "1" ||
        rawValue === "true";
      await locator.setChecked(checked);
      continue;
    }
    await locator.fill(value);
  }
}

export async function evaluateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  fn: string;
  ref?: string;
}): Promise<unknown> {
  const fnText = String(opts.fn ?? "").trim();
  if (!fnText) throw new Error("function is required");
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  if (opts.ref) {
    const locator = refLocator(page, opts.ref);
    // Use Function constructor at runtime to avoid esbuild adding __name helper
    // which doesn't exist in the browser context
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- required for browser-context eval
    const elementEvaluator = new Function(
      "el",
      "fnBody",
      `
      "use strict";
      try {
        var candidate = eval("(" + fnBody + ")");
        return typeof candidate === "function" ? candidate(el) : candidate;
      } catch (err) {
        throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
      }
      `,
    ) as (el: Element, fnBody: string) => unknown;
    return await locator.evaluate(elementEvaluator, fnText);
  }
  // Use Function constructor at runtime to avoid esbuild adding __name helper
  // which doesn't exist in the browser context
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- required for browser-context eval
  const browserEvaluator = new Function(
    "fnBody",
    `
    "use strict";
    try {
      var candidate = eval("(" + fnBody + ")");
      return typeof candidate === "function" ? candidate() : candidate;
    } catch (err) {
      throw new Error("Invalid evaluate function: " + (err && err.message ? err.message : String(err)));
    }
    `,
  ) as (fnBody: string) => unknown;
  return await page.evaluate(browserEvaluator, fnText);
}

export async function armFileUploadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  paths?: string[];
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const timeout = Math.max(500, Math.min(120_000, opts.timeoutMs ?? 120_000));

  state.armIdUpload = nextUploadArmId += 1;
  const armId = state.armIdUpload;

  void page
    .waitForEvent("filechooser", { timeout })
    .then(async (fileChooser) => {
      if (state.armIdUpload !== armId) return;
      if (!opts.paths?.length) {
        // Playwright removed `FileChooser.cancel()`; best-effort close the chooser instead.
        try {
          await page.keyboard.press("Escape");
        } catch {
          // Best-effort.
        }
        return;
      }
      await fileChooser.setFiles(opts.paths);
      try {
        const input =
          typeof fileChooser.element === "function"
            ? await Promise.resolve(fileChooser.element())
            : null;
        if (input) {
          await input.evaluate((el) => {
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          });
        }
      } catch {
        // Best-effort for sites that don't react to setFiles alone.
      }
    })
    .catch(() => {
      // Ignore timeouts; the chooser may never appear.
    });
}

export async function setInputFilesViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  inputRef?: string;
  element?: string;
  paths: string[];
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  if (!opts.paths.length) throw new Error("paths are required");
  const inputRef =
    typeof opts.inputRef === "string" ? opts.inputRef.trim() : "";
  const element = typeof opts.element === "string" ? opts.element.trim() : "";
  if (inputRef && element) {
    throw new Error("inputRef and element are mutually exclusive");
  }
  if (!inputRef && !element) {
    throw new Error("inputRef or element is required");
  }

  const locator = inputRef
    ? refLocator(page, inputRef)
    : page.locator(element).first();

  await locator.setInputFiles(opts.paths);
  try {
    const handle = await locator.elementHandle();
    if (handle) {
      await handle.evaluate((el) => {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
  } catch {
    // Best-effort for sites that don't react to setInputFiles alone.
  }
}

export async function armDialogViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  accept: boolean;
  promptText?: string;
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const timeout = Math.max(500, Math.min(120_000, opts.timeoutMs ?? 120_000));

  state.armIdDialog = nextDialogArmId += 1;
  const armId = state.armIdDialog;

  void page
    .waitForEvent("dialog", { timeout })
    .then(async (dialog) => {
      if (state.armIdDialog !== armId) return;
      if (opts.accept) await dialog.accept(opts.promptText);
      else await dialog.dismiss();
    })
    .catch(() => {
      // Ignore timeouts; the dialog may never appear.
    });
}

export async function navigateViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  url: string;
  timeoutMs?: number;
}): Promise<{ url: string }> {
  const url = String(opts.url ?? "").trim();
  if (!url) throw new Error("url is required");
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.goto(url, {
    timeout: Math.max(1000, Math.min(120_000, opts.timeoutMs ?? 20_000)),
  });
  return { url: page.url() };
}

export async function waitForViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  timeMs?: number;
  text?: string;
  textGone?: string;
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  if (typeof opts.timeMs === "number" && Number.isFinite(opts.timeMs)) {
    await page.waitForTimeout(Math.max(0, opts.timeMs));
  }
  if (opts.text) {
    await page
      .getByText(opts.text)
      .first()
      .waitFor({
        state: "visible",
        timeout: Math.max(500, Math.min(120_000, opts.timeoutMs ?? 20_000)),
      });
  }
  if (opts.textGone) {
    await page
      .getByText(opts.textGone)
      .first()
      .waitFor({
        state: "hidden",
        timeout: Math.max(500, Math.min(120_000, opts.timeoutMs ?? 20_000)),
      });
  }
}

export async function takeScreenshotViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref?: string;
  element?: string;
  fullPage?: boolean;
  type?: "png" | "jpeg";
}): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const type = opts.type ?? "png";
  if (opts.ref) {
    if (opts.fullPage)
      throw new Error("fullPage is not supported for element screenshots");
    const locator = refLocator(page, opts.ref);
    const buffer = await locator.screenshot({ type });
    return { buffer };
  }
  if (opts.element) {
    if (opts.fullPage)
      throw new Error("fullPage is not supported for element screenshots");
    const locator = page.locator(opts.element).first();
    const buffer = await locator.screenshot({ type });
    return { buffer };
  }
  const buffer = await page.screenshot({
    type,
    fullPage: Boolean(opts.fullPage),
  });
  return { buffer };
}

export async function resizeViewportViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  width: number;
  height: number;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.setViewportSize({
    width: Math.max(1, Math.floor(opts.width)),
    height: Math.max(1, Math.floor(opts.height)),
  });
}

export async function closePageViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.close();
}

export async function pdfViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const buffer = await page.pdf({ printBackground: true });
  return { buffer };
}

function consolePriority(level: string) {
  switch (level) {
    case "error":
      return 3;
    case "warning":
      return 2;
    case "info":
    case "log":
      return 1;
    case "debug":
      return 0;
    default:
      return 1;
  }
}

export async function getConsoleMessagesViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  level?: string;
}): Promise<BrowserConsoleMessage[]> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  if (!opts.level) return [...state.console];
  const min = consolePriority(opts.level);
  return state.console.filter((msg) => consolePriority(msg.type) >= min);
}
