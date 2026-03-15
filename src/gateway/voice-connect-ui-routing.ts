import { normalizeVoiceConnectBasePath } from "./voice-connect-ui-shared.js";

export type VoiceConnectUiRequestClassification =
  | { kind: "none" }
  | { kind: "redirect"; location: string }
  | { kind: "ui"; pathname: string; search: string };

export function classifyVoiceConnectUiRequest(opts: {
  url: URL;
  basePath?: string;
}): VoiceConnectUiRequestClassification {
  const basePath = normalizeVoiceConnectBasePath(opts.basePath);
  const { pathname, search } = opts.url;

  if (!pathname.startsWith(basePath)) {
    return { kind: "none" };
  }

  // Redirect `/voice-connect` -> `/voice-connect/` for SPA base stability.
  if (pathname === basePath) {
    return { kind: "redirect", location: `${basePath}/${search}` };
  }

  return { kind: "ui", pathname, search };
}
