const DEVICE_AUTH_URL_RE =
  /\bhttps?:\/\/[^\s<>"']*(?:login\.microsoft\.com\/device|microsoft\.com\/devicelogin|aka\.ms\/devicelogin|\/oauth2?\/device|\/device(?:code|login)?\b|device[-_]?code|device[-_]?login)[^\s<>"']*/iu;
const LOCAL_CALLBACK_URL_RE =
  /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{2,5})?(?:\/[^\s<>"']*)?\b/iu;
const SETUP_CODE_LINE_RE =
  /\b(?:user|device|verification|setup|one[-_\s]?time)?[-_\s]?(?:code|token)\b.*\b[A-Z0-9]{4,12}(?:-[A-Z0-9]{2,12}){0,4}\b/iu;
const NEXT_ACTION_INSTRUCTION_RE =
  /\b(?:enter|use|copy|paste|open|visit)\b.{0,120}\b(?:code|token|url|link|browser|callback|device|verification|setup)\b/iu;

/** Matches short command-output lines users need in order to complete setup/auth flows. */
export function isActionCriticalOutputLine(line: string): boolean {
  const text = line.trim();
  if (!text) {
    return false;
  }
  return (
    DEVICE_AUTH_URL_RE.test(text) ||
    LOCAL_CALLBACK_URL_RE.test(text) ||
    SETUP_CODE_LINE_RE.test(text) ||
    NEXT_ACTION_INSTRUCTION_RE.test(text)
  );
}
