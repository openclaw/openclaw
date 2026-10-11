import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

it("isolates built runtime imports from inherited home, state, and config paths", () => {
  const root = roots.make("build-smoke-isolation-test-");
  const dist = path.join(root, "dist");
  fs.mkdirSync(dist);
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  const inherited = path.join(root, "caller");
  fs.mkdirSync(inherited);
  const keys = [
    "HOME",
    "USERPROFILE",
    "OPENCLAW_HOME",
    "OPENCLAW_STATE_DIR",
    "OPENCLAW_CONFIG_PATH",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
  ];
  const receipt = path.join(root, "env.json");
  fs.writeFileSync(
    path.join(dist, "status-message.runtime.js"),
    `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(Object.fromEntries(
  ${JSON.stringify(keys)}.map(key => [key, process.env[key]])
)));
export function loadStatusMessageRuntimeModule() {
  return { buildStatusMessageParts() {} };
}
`,
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/test-built-status-message-runtime.mts", "--package-root", root],
    {
      encoding: "utf8",
      env: { ...process.env, ...Object.fromEntries(keys.map((key) => [key, inherited])) },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const actual = JSON.parse(fs.readFileSync(receipt, "utf8")) as Record<string, string>;
  for (const key of keys) {
    expect(actual[key], key).toBeTruthy();
    expect(actual[key], key).not.toBe(inherited);
  }
  const home = actual.HOME;
  assert.ok(home);
  for (const [key, value] of Object.entries(actual).filter(([key]) => key !== "HOME")) {
    const relative = path.relative(home, value);
    expect(path.isAbsolute(relative), key).toBe(false);
    expect(relative.startsWith(".."), key).toBe(false);
  }
});
