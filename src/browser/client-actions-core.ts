import type {
  BrowserActionOk,
  BrowserActionPathResult,
  BrowserActionTabResult,
} from "./client-actions-types.js";
import { fetchBrowserJson } from "./client-fetch.js";

function buildProfileQuery(profile?: string): string {
  return profile ? `?profile=${encodeURIComponent(profile)}` : "";
}

export type BrowserFormField = {
  ref: string;
  type: string;
  value?: string | number | boolean;
};

export type BrowserActRequest =
  | {
      kind: "click";
      ref: string;
      targetId?: string;
      doubleClick?: boolean;
      button?: string;
      modifiers?: string[];
    }
  | {
      kind: "type";
      ref: string;
      text: string;
      targetId?: string;
      submit?: boolean;
      slowly?: boolean;
    }
  | { kind: "press"; key: string; targetId?: string }
  | { kind: "hover"; ref: string; targetId?: string }
  | { kind: "drag"; startRef: string; endRef: string; targetId?: string }
  | { kind: "select"; ref: string; values: string[]; targetId?: string }
  | {
      kind: "fill";
      fields: BrowserFormField[];
      targetId?: string;
    }
  | { kind: "resize"; width: number; height: number; targetId?: string }
  | {
      kind: "wait";
      timeMs?: number;
      text?: string;
      textGone?: string;
      targetId?: string;
    }
  | { kind: "evaluate"; fn: string; ref?: string; targetId?: string }
  | { kind: "close"; targetId?: string };

export type BrowserActResponse = {
  ok: true;
  targetId: string;
  url?: string;
  result?: unknown;
};

export async function browserNavigate(
  baseUrl: string,
  opts: { url: string; targetId?: string; profile?: string },
): Promise<BrowserActionTabResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTabResult>(
    `${baseUrl}/navigate${q}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: opts.url, targetId: opts.targetId }),
      timeoutMs: 20000,
    },
  );
}

export async function browserArmDialog(
  baseUrl: string,
  opts: {
    accept: boolean;
    promptText?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserActionOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionOk>(
    `${baseUrl}/hooks/dialog${q}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        accept: opts.accept,
        promptText: opts.promptText,
        targetId: opts.targetId,
        timeoutMs: opts.timeoutMs,
      }),
      timeoutMs: 20000,
    },
  );
}

export async function browserArmFileChooser(
  baseUrl: string,
  opts: {
    paths: string[];
    ref?: string;
    inputRef?: string;
    element?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserActionOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionOk>(
    `${baseUrl}/hooks/file-chooser${q}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: opts.paths,
        ref: opts.ref,
        inputRef: opts.inputRef,
        element: opts.element,
        targetId: opts.targetId,
        timeoutMs: opts.timeoutMs,
      }),
      timeoutMs: 20000,
    },
  );
}

export async function browserAct(
  baseUrl: string,
  req: BrowserActRequest,
  opts?: { profile?: string },
): Promise<BrowserActResponse> {
  const q = buildProfileQuery(opts?.profile);
  return await fetchBrowserJson<BrowserActResponse>(`${baseUrl}/act${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    timeoutMs: 20000,
  });
}

export async function browserScreenshotAction(
  baseUrl: string,
  opts: {
    targetId?: string;
    fullPage?: boolean;
    ref?: string;
    element?: string;
    type?: "png" | "jpeg";
    profile?: string;
  },
): Promise<BrowserActionPathResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionPathResult>(
    `${baseUrl}/screenshot${q}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        targetId: opts.targetId,
        fullPage: opts.fullPage,
        ref: opts.ref,
        element: opts.element,
        type: opts.type,
      }),
      timeoutMs: 20000,
    },
  );
}
