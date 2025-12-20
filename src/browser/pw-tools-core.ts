import {
  ensurePageState,
  getPageForTargetId,
  refLocator,
  type WithSnapshotForAI,
} from "./pw-session.js";

let nextUploadArmId = 0;
let nextDialogArmId = 0;

export async function snapshotAiViaPlaywright(opts: {
  cdpPort: number;
  targetId?: string;
  timeoutMs?: number;
}): Promise<{ snapshot: string }> {
  const page = await getPageForTargetId({
    cdpPort: opts.cdpPort,
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
  return { snapshot: String(result?.full ?? "") };
}

export async function clickRefViaPlaywright(opts: {
  cdpPort: number;
  targetId?: string;
  ref: string;
  timeoutMs?: number;
}): Promise<void> {
  await clickViaPlaywright(opts);
}

export async function clickViaPlaywright(opts: {
  cdpPort: number;
  targetId?: string;
  ref: string;
  doubleClick?: boolean;
  button?: "left" | "right" | "middle";
  modifiers?: Array<"Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift">;
  timeoutMs?: number;
}): Promise<void> {
  const ref = String(opts.ref ?? "").trim();
  if (!ref) throw new Error("ref is required");

  const page = await getPageForTargetId({
    cdpPort: opts.cdpPort,
    targetId: opts.targetId,
  });
  ensurePageState(page);
  const locator = refLocator(page, ref);
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
  cdpPort: number;
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
  cdpPort: number;
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
  cdpPort: number;
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
  cdpPort: number;
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
  cdpPort: number;
  targetId?: string;
  ref: string;
  text: string;
  submit?: boolean;
  slowly?: boolean;
  timeoutMs?: number;
}): Promise<void> {
  const ref = String(opts.ref ?? "").trim();
  if (!ref) throw new Error("ref is required");
  const text = String(opts.text ?? "");
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const locator = refLocator(page, ref);
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
  cdpPort: number;
  targetId?: string;
  fields: Array<Record<string, unknown>>;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  for (const field of opts.fields) {
    const ref = String(field.ref ?? "").trim();
    const type = String(field.type ?? "").trim();
    const value = String(field.value ?? "");
    if (!ref || !type) continue;
    const locator = refLocator(page, ref);
    if (type === "checkbox" || type === "radio") {
      await locator.setChecked(value === "true");
      continue;
    }
    await locator.fill(value);
  }
}

export async function evaluateViaPlaywright(opts: {
  cdpPort: number;
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
    return await locator.evaluate((el, fnBody) => {
      const runner = new Function(
        "element",
        `"use strict"; const fn = ${fnBody}; return fn(element);`,
      ) as (element: Element) => unknown;
      return runner(el as Element);
    }, fnText);
  }
  return await page.evaluate((fnBody) => {
    const runner = new Function(
      `"use strict"; const fn = ${fnBody}; return fn();`,
    ) as () => unknown;
    return runner();
  }, fnText);
}

export async function armFileUploadViaPlaywright(opts: {
  cdpPort: number;
  targetId?: string;
  paths?: string[];
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const timeout = Math.max(500, Math.min(60_000, opts.timeoutMs ?? 10_000));

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
    })
    .catch(() => {
      // Ignore timeouts; the chooser may never appear.
    });
}

export async function armDialogViaPlaywright(opts: {
  cdpPort: number;
  targetId?: string;
  accept: boolean;
  promptText?: string;
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const timeout = Math.max(500, Math.min(60_000, opts.timeoutMs ?? 10_000));

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
  cdpPort: number;
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
  cdpPort: number;
  targetId?: string;
  time?: number;
  text?: string;
  textGone?: string;
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  if (typeof opts.time === "number" && Number.isFinite(opts.time)) {
    await page.waitForTimeout(Math.max(0, opts.time) * 1000);
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
  cdpPort: number;
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
  const buffer = await page.screenshot({
    type,
    fullPage: Boolean(opts.fullPage),
  });
  return { buffer };
}

export async function resizeViewportViaPlaywright(opts: {
  cdpPort: number;
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
  cdpPort: number;
  targetId?: string;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  await page.close();
}

export async function pdfViaPlaywright(opts: {
  cdpPort: number;
  targetId?: string;
}): Promise<{ buffer: Buffer }> {
  const page = await getPageForTargetId(opts);
  ensurePageState(page);
  const buffer = await page.pdf({ printBackground: true });
  return { buffer };
}
