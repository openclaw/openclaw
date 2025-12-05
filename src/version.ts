import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };

// Single source of truth for the current clawdis version (reads from package.json).
export const VERSION = pkg.version ?? "0.0.0";
