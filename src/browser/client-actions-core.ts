import type {
  BrowserActionOk,
  BrowserActionPathResult,
  BrowserActionTabResult,
} from "./client-actions-types.js";
import { buildProfileQuery, withBaseUrl } from "./client-actions-url.js";
import { fetchBrowserJson } from "./client-fetch.js";

export type BrowserFormField = {
  ref: string;
  type: string;
  value?: string | number | boolean;
};

export type BrowserActVerifyMode = "screenshot";

export type BrowserActRequest =
  | {
      kind: "click";
      ref?: string;
      selector?: string;
      targetId?: string;
      doubleClick?: boolean;
      button?: string;
      modifiers?: string[];
      delayMs?: number;
      timeoutMs?: number;
      verifyWith?: BrowserActVerifyMode;
    }
  | {
      kind: "click-coords";
      x: number;
      y: number;
      targetId?: string;
      doubleClick?: boolean;
      button?: string;
      verifyWith?: BrowserActVerifyMode;
    }
  | {
      kind: "type";
      ref?: string;
      selector?: string;
      text: string;
      targetId?: string;
      submit?: boolean;
      slowly?: boolean;
      timeoutMs?: number;
      verifyWith?: BrowserActVerifyMode;
    }
  | {
      kind: "press";
      key: string;
      targetId?: string;
      delayMs?: number;
      verifyWith?: BrowserActVerifyMode;
    }
  | {
      kind: "hover";
      ref?: string;
      selector?: string;
      targetId?: string;
      timeoutMs?: number;
      verifyWith?: BrowserActVerifyMode;
    }
  | {
      kind: "scrollIntoView" | "scrollintoview";
      ref?: string;
      selector?: string;
      targetId?: string;
      timeoutMs?: number;
      verifyWith?: BrowserActVerifyMode;
    }
  | {
      kind: "drag";
      startRef?: string;
      startSelector?: string;
      endRef?: string;
      endSelector?: string;
      targetId?: string;
      timeoutMs?: number;
      verifyWith?: BrowserActVerifyMode;
    }
  | {
      kind: "select";
      ref?: string;
      selector?: string;
      values: string[];
      targetId?: string;
      timeoutMs?: number;
      verifyWith?: BrowserActVerifyMode;
    }
  | {
      kind: "fill";
      fields: BrowserFormField[];
      targetId?: string;
      timeoutMs?: number;
      verifyWith?: BrowserActVerifyMode;
    }
  | {
      kind: "resize";
      width: number;
      height: number;
      targetId?: string;
      verifyWith?: BrowserActVerifyMode;
    }
  | {
      kind: "wait";
      timeMs?: number;
      text?: string;
      textGone?: string;
      selector?: string;
      url?: string;
      loadState?: "load" | "domcontentloaded" | "networkidle";
      fn?: string;
      targetId?: string;
      timeoutMs?: number;
      verifyWith?: BrowserActVerifyMode;
    }
  | {
      kind: "evaluate";
      fn: string;
      ref?: string;
      targetId?: string;
      timeoutMs?: number;
      verifyWith?: BrowserActVerifyMode;
    }
  | {
      kind: "close";
      targetId?: string;
      verifyWith?: BrowserActVerifyMode;
    }
  | {
      kind: "batch";
      actions: BrowserActRequest[];
      targetId?: string;
      stopOnError?: boolean;
      verifyWith?: BrowserActVerifyMode;
    };

export type BrowserActVerification = {
  mode: BrowserActVerifyMode;
  path: string;
};

export type BrowserActResponse = {
  ok: true;
  targetId: string;
  url?: string;
  result?: unknown;
  results?: Array<{ ok: boolean; error?: string }>;
  verification?: BrowserActVerification;
};

export type BrowserDownloadPayload = {
  url: string;
  suggestedFilename: string;
  path: string;
};

type BrowserDownloadResult = { ok: true; targetId: string; download: BrowserDownloadPayload };

async function postDownloadRequest(
  baseUrl: string | undefined,
  route: "/wait/download" | "/download",
  body: Record<string, unknown>,
  profile?: string,
): Promise<BrowserDownloadResult> {
  const q = buildProfileQuery(profile);
  return await fetchBrowserJson<BrowserDownloadResult>(withBaseUrl(baseUrl, `${route}${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 20000,
  });
}

export async function browserNavigate(
  baseUrl: string | undefined,
  opts: {
    url: string;
    targetId?: string;
    profile?: string;
  },
): Promise<BrowserActionTabResult> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionTabResult>(withBaseUrl(baseUrl, `/navigate${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: opts.url, targetId: opts.targetId }),
    timeoutMs: 20000,
  });
}

export async function browserArmDialog(
  baseUrl: string | undefined,
  opts: {
    accept: boolean;
    promptText?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserActionOk> {
  const q = buildProfileQuery(opts.profile);
  return await fetchBrowserJson<BrowserActionOk>(withBaseUrl(baseUrl, `/hooks/dialog${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accept: opts.accept,
      promptText: opts.promptText,
      targetId: opts.targetId,
      timeoutMs: opts.timeoutMs,
    }),
    timeoutMs: 20000,
  });
}

export async function browserArmFileChooser(
  baseUrl: string | undefined,
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
  return await fetchBrowserJson<BrowserActionOk>(withBaseUrl(baseUrl, `/hooks/file-chooser${q}`), {
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
  });
}

export async function browserWaitForDownload(
  baseUrl: string | undefined,
  opts: {
    path?: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserDownloadResult> {
  return await postDownloadRequest(
    baseUrl,
    "/wait/download",
    {
      targetId: opts.targetId,
      path: opts.path,
      timeoutMs: opts.timeoutMs,
    },
    opts.profile,
  );
}

export async function browserDownload(
  baseUrl: string | undefined,
  opts: {
    ref: string;
    path: string;
    targetId?: string;
    timeoutMs?: number;
    profile?: string;
  },
): Promise<BrowserDownloadResult> {
  return await postDownloadRequest(
    baseUrl,
    "/download",
    {
      targetId: opts.targetId,
      ref: opts.ref,
      path: opts.path,
      timeoutMs: opts.timeoutMs,
    },
    opts.profile,
  );
}

export async function browserAct(
  baseUrl: string | undefined,
  req: BrowserActRequest,
  opts?: { profile?: string },
): Promise<BrowserActResponse> {
  const q = buildProfileQuery(opts?.profile);
  return await fetchBrowserJson<BrowserActResponse>(withBaseUrl(baseUrl, `/act${q}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    timeoutMs: 20000,
  });
}

export async function browserScreenshotAction(
  baseUrl: string | undefined,
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
  return await fetchBrowserJson<BrowserActionPathResult>(withBaseUrl(baseUrl, `/screenshot${q}`), {
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
  });
}
