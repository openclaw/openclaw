import type { ScreenshotResult } from "./client.js";
import type {
  BrowserActionOk,
  BrowserActionTabResult,
} from "./client-actions-types.js";
import { fetchBrowserJson } from "./client-fetch.js";

export async function browserNavigate(
  baseUrl: string,
  opts: { url: string; targetId?: string },
): Promise<BrowserActionTabResult> {
  return await fetchBrowserJson<BrowserActionTabResult>(`${baseUrl}/navigate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: opts.url, targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}

export async function browserResize(
  baseUrl: string,
  opts: { width: number; height: number; targetId?: string },
): Promise<BrowserActionTabResult> {
  return await fetchBrowserJson<BrowserActionTabResult>(`${baseUrl}/resize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      width: opts.width,
      height: opts.height,
      targetId: opts.targetId,
    }),
    timeoutMs: 20000,
  });
}

export async function browserClosePage(
  baseUrl: string,
  opts: { targetId?: string } = {},
): Promise<BrowserActionTabResult> {
  return await fetchBrowserJson<BrowserActionTabResult>(`${baseUrl}/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}

export async function browserClick(
  baseUrl: string,
  opts: {
    ref: string;
    targetId?: string;
    doubleClick?: boolean;
    button?: string;
    modifiers?: string[];
  },
): Promise<BrowserActionTabResult> {
  return await fetchBrowserJson<BrowserActionTabResult>(`${baseUrl}/click`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: opts.ref,
      targetId: opts.targetId,
      doubleClick: opts.doubleClick,
      button: opts.button,
      modifiers: opts.modifiers,
    }),
    timeoutMs: 20000,
  });
}

export async function browserType(
  baseUrl: string,
  opts: {
    ref: string;
    text: string;
    targetId?: string;
    submit?: boolean;
    slowly?: boolean;
  },
): Promise<BrowserActionTabResult> {
  return await fetchBrowserJson<BrowserActionTabResult>(`${baseUrl}/type`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: opts.ref,
      text: opts.text,
      targetId: opts.targetId,
      submit: opts.submit,
      slowly: opts.slowly,
    }),
    timeoutMs: 20000,
  });
}

export async function browserPressKey(
  baseUrl: string,
  opts: { key: string; targetId?: string },
): Promise<BrowserActionTabResult> {
  return await fetchBrowserJson<BrowserActionTabResult>(`${baseUrl}/press`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: opts.key, targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}

export async function browserHover(
  baseUrl: string,
  opts: { ref: string; targetId?: string },
): Promise<BrowserActionTabResult> {
  return await fetchBrowserJson<BrowserActionTabResult>(`${baseUrl}/hover`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: opts.ref, targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}

export async function browserDrag(
  baseUrl: string,
  opts: { startRef: string; endRef: string; targetId?: string },
): Promise<BrowserActionTabResult> {
  return await fetchBrowserJson<BrowserActionTabResult>(`${baseUrl}/drag`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startRef: opts.startRef,
      endRef: opts.endRef,
      targetId: opts.targetId,
    }),
    timeoutMs: 20000,
  });
}

export async function browserSelectOption(
  baseUrl: string,
  opts: { ref: string; values: string[]; targetId?: string },
): Promise<BrowserActionTabResult> {
  return await fetchBrowserJson<BrowserActionTabResult>(`${baseUrl}/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ref: opts.ref,
      values: opts.values,
      targetId: opts.targetId,
    }),
    timeoutMs: 20000,
  });
}

export async function browserUpload(
  baseUrl: string,
  opts: { paths?: string[]; targetId?: string } = {},
): Promise<BrowserActionTabResult> {
  return await fetchBrowserJson<BrowserActionTabResult>(`${baseUrl}/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: opts.paths, targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}

export async function browserFillForm(
  baseUrl: string,
  opts: { fields: Array<Record<string, unknown>>; targetId?: string },
): Promise<BrowserActionTabResult> {
  return await fetchBrowserJson<BrowserActionTabResult>(`${baseUrl}/fill`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields: opts.fields, targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}

export async function browserHandleDialog(
  baseUrl: string,
  opts: { accept: boolean; promptText?: string; targetId?: string },
): Promise<BrowserActionOk> {
  return await fetchBrowserJson<BrowserActionOk>(`${baseUrl}/dialog`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accept: opts.accept,
      promptText: opts.promptText,
      targetId: opts.targetId,
    }),
    timeoutMs: 20000,
  });
}

export async function browserWaitFor(
  baseUrl: string,
  opts: {
    time?: number;
    text?: string;
    textGone?: string;
    targetId?: string;
  },
): Promise<BrowserActionTabResult> {
  return await fetchBrowserJson<BrowserActionTabResult>(`${baseUrl}/wait`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      time: opts.time,
      text: opts.text,
      textGone: opts.textGone,
      targetId: opts.targetId,
    }),
    timeoutMs: 20000,
  });
}

export async function browserEvaluate(
  baseUrl: string,
  opts: { fn: string; ref?: string; targetId?: string },
): Promise<{ ok: true; result: unknown }> {
  return await fetchBrowserJson<{ ok: true; result: unknown }>(
    `${baseUrl}/evaluate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        function: opts.fn,
        ref: opts.ref,
        targetId: opts.targetId,
      }),
      timeoutMs: 20000,
    },
  );
}

export async function browserScreenshotAction(
  baseUrl: string,
  opts: {
    targetId?: string;
    fullPage?: boolean;
    ref?: string;
    element?: string;
    type?: "png" | "jpeg";
    filename?: string;
  },
): Promise<ScreenshotResult & { filename?: string }> {
  return await fetchBrowserJson<ScreenshotResult & { filename?: string }>(
    `${baseUrl}/screenshot`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetId: opts.targetId,
        fullPage: opts.fullPage,
        ref: opts.ref,
        element: opts.element,
        type: opts.type,
        filename: opts.filename,
      }),
      timeoutMs: 20000,
    },
  );
}
