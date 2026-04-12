import path from "node:path";

/**
 * Gateway-relative URL prefix used to serve workspace/local files
 * to the webchat UI as media (images, etc.).
 */
export const WORKSPACE_FILE_PREFIX = "/__file__";

/**
 * Matches markdown image syntax: ![alt](href) or ![alt](href "title")
 * Captures: full match, alt text, href (without title).
 */
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)"'\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;

const REMOTE_URL_RE = /^https?:\/\//i;
const DATA_URL_RE = /^data:/i;
const ALREADY_TRANSFORMED_RE = /^\/__file__\//;

/**
 * Transforms local file paths inside markdown image syntax to gateway-served
 * `/__file__/<base64url>` URLs.
 *
 * - Remote URLs (http/https) are left untouched.
 * - Data URIs are left untouched.
 * - Relative paths are resolved against `workspaceDir`.
 * - Absolute paths are used as-is after normalisation.
 */
export function transformMarkdownImagePaths(
  text: string,
  workspaceDir: string | undefined,
  basePath: string,
): string {
  if (!text.includes("![")) {
    return text;
  }
  return text.replace(MARKDOWN_IMAGE_RE, (match, alt: string, href: string) => {
    const trimmedHref = href.trim();
    if (
      REMOTE_URL_RE.test(trimmedHref) ||
      DATA_URL_RE.test(trimmedHref) ||
      ALREADY_TRANSFORMED_RE.test(trimmedHref)
    ) {
      return match;
    }
    let absolutePath: string;
    if (path.isAbsolute(trimmedHref)) {
      absolutePath = path.resolve(trimmedHref);
    } else if (workspaceDir) {
      absolutePath = path.resolve(workspaceDir, trimmedHref);
    } else {
      // Cannot resolve relative path without a workspace dir — leave as-is.
      return match;
    }
    const encoded = Buffer.from(absolutePath).toString("base64url");
    const prefix = basePath ? `${basePath}${WORKSPACE_FILE_PREFIX}` : WORKSPACE_FILE_PREFIX;
    return `![${alt}](${prefix}/${encoded})`;
  });
}
