import { createHash } from "node:crypto";
import { OAUTH_PAGE_STYLES } from "../shared/oauth-page.js";

export const OAUTH_PAGE_CSP = `default-src 'none'; style-src 'sha256-${createHash("sha256").update(OAUTH_PAGE_STYLES).digest("base64")}'; frame-ancestors 'none'`;
