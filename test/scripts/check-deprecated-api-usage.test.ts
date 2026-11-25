import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";
import { writeFixtureFiles } from "./z0632-fixtures.test-support.js";

const { createTempDir } = createScriptTestHarness();
const inbound = "openclaw/plugin-sdk/inbound-reply-dispatch";

it("scans overlapping roots once and reports violations in rule/root order", () => {
  const root = fs.realpathSync(createTempDir("deprecated-guard-"));
  const preload = path.join(root, "account-source-io.mjs");
  writeFixtureFiles(root, {
    "src/a.ts": `import { x } from "${inbound}";\nimport { y } from "@${inbound}";\ndeliverOutboundPayloads();`,
    "extensions/probe/a.ts": `export { x } from "${inbound}";\ndeliverOutboundPayloads();`,
    "packages/a.ts": `import { x } from "openclaw/plugin-sdk/agent-media-payload";\ndeliverOutboundPayloads();`,
    "src/infra/outbound/deliver.ts": "deliverOutboundPayloads();",
    "src/a.test.ts": "deliverOutboundPayloads();",
    "account-source-io.mjs": `import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const seen = new Set();
for (const method of ["readFileSync", "readdirSync"]) {
  const original = fs[method];
  fs[method] = function (file, ...args) {
    const relative = typeof file === "string" ? path.relative(process.cwd(), file).split(path.sep).join("/") : "";
    if (/^(src|extensions|packages)(\\/|$)/.test(relative)) {
      const key = method + ":" + relative;
      if (seen.has(key)) throw new Error("Repeated source I/O: " + key);
      seen.add(key);
    }
    return original.call(this, file, ...args);
  };
}
syncBuiltinESMExports();
`,
  });
  const rules = [
    "message-api",
    "facade-internal-imports",
    "extension-plugin-sdk-compat-subpaths",
    "plugin-sdk-compat-subpaths",
  ];
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(preload).href,
      fileURLToPath(new URL("../../scripts/check-deprecated-api-usage.mts", import.meta.url)),
      ...rules.map((id) => `--rule=${id}`),
    ],
    { cwd: root, encoding: "utf8" },
  );
  expect(result).toMatchObject({ status: 1, stdout: "" });
  const locations = [...result.stderr.matchAll(/^- ([^:]+): ([^:]+:\d+): /gm)].map(
    ([, rule, location]) => `${rule}: ${location}`,
  );
  expect(locations).toEqual([
    ...["src/a.ts:1", "src/a.ts:2", "packages/a.ts:1"].map(
      (file) => `plugin-sdk-compat-subpaths: ${file}`,
    ),
    "extension-plugin-sdk-compat-subpaths: extensions/probe/a.ts:1",
    ...["src/a.ts:1", "src/a.ts:2", "extensions/probe/a.ts:1"].map(
      (file) => `facade-internal-imports: ${file}`,
    ),
    ...["src/a.ts:3", "extensions/probe/a.ts:2", "packages/a.ts:2"].map(
      (file) => `message-api: ${file}`,
    ),
  ]);
});
