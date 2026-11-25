import fs, { readdirSync as scan } from "node:fs";
import { readdir } from "node:fs/promises";
fs.readdir("root", { recursive: true }, () => {});
fs.readdirSync("root", { recursive: true });
fs.promises.readdir("root", { recursive: true });
readdir("root", { recursive: true, withFileTypes: true });
scan("root", { withFileTypes: true, recursive: true });
fs["readdirSync"]("root", { recursive: true });
const options = { recursive: true };
fs.readdirSync("root", options);
fs.promises.readdir("root", options);
readdir("root", options);
scan("root", options);
const recursive = true;
fs.readdirSync("root", { recursive });
fs.readdirSync("root", { recursive: true } as const);
fs.readdirSync("root", { recursive: true } satisfies { recursive: boolean });
const { readdirSync: destructured } = fs;
destructured("root", options);
const { readdir: promised } = fs.promises;
promised("root", options);
const { readdirSync: required } = require("fs");
required("root", options);
const renamed = fs.readdirSync;
renamed("root", options);
function dynamic(options: { recursive?: boolean }) {
  fs.readdirSync("root", options);
}
const safeOptions = { recursive: false };
fs.readdirSync("root", safeOptions);
fs.promises.readdir("root", safeOptions);
readdir("root", safeOptions);
scan("root", safeOptions);
destructured("root", safeOptions);
promised("root", safeOptions);
required("root", safeOptions);
renamed("root", safeOptions);
fs.readdirSync("root", { recursive: false } as const);
fs.readdirSync("root", { recursive: false } satisfies { recursive: boolean });
fs.readdirSync("root", { withFileTypes: true });
fs.readdirSync("root", "utf8");
fs.readdir("root", () => {});
fs.mkdirSync("root", { recursive: true });
const local = { readdirSync(_root: string, _options: unknown) {} };
local.readdirSync("root", { recursive: true });
function shadowed(fs: typeof local) {
  fs.readdirSync("root", { recursive: true });
}
{
  const recursive = false;
  fs.readdirSync("root", { recursive });
}
// oxlint-disable-next-line openclaw-boundaries/no-recursive-readdir -- Deliberate fixture of the narrow exception mechanism.
fs.readdirSync("root", { recursive: true });
void [dynamic, shadowed];
