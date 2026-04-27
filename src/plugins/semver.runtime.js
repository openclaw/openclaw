import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const semver = require("semver");
export const satisfies = (version, range, options) => semver.satisfies(version, range, options);
export const validSemver = (version) => semver.valid(version);
export const validRange = (range) => semver.validRange(range);
