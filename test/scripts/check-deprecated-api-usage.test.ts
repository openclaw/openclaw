import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { buildDeprecatedPluginSdkModuleSpecifiers } from "../../scripts/lib/deprecated-plugin-sdk-usage.mts";
import { createScriptTestHarness } from "./test-helpers.js";

const inbound = "openclaw/plugin-sdk/inbound-reply-dispatch";
const migration = "use focused non-deprecated plugin SDK subpaths";
const facade = "use openclaw/plugin-sdk/channel-inbound";
const message =
  "deliverOutboundPayloads (use sendDurableMessageBatch or deliverInboundReplyWithMessageSendContext)";
const onceEach = (paths: string) => Object.fromEntries(paths.split(" ").map((file) => [file, 1]));
const { createTempDir } = createScriptTestHarness();

it("keeps removed root and private compatibility aliases out of the inventory", () => {
  const specifiers = buildDeprecatedPluginSdkModuleSpecifiers();
  for (const suffix of ["", "/agent-dir-compat", "/test-utils"]) {
    expect(specifiers).not.toContain(`openclaw/plugin-sdk${suffix}`);
  }
});

it("reads overlapping rule inputs once while preserving complete diagnostic order", () => {
  const fixtureRoot = fs.realpathSync(createTempDir("deprecated-guard-"));
  for (const [repoPath, source] of Object.entries({
    "src/a.ts": `import { x } from "${inbound}";\nimport { y } from "@${inbound}";\ndeliverOutboundPayloads();`,
    "extensions/probe/src/a.ts": `export { x } from "${inbound}";\ndeliverOutboundPayloads();`,
    "packages/a.ts":
      'import { x } from "openclaw/plugin-sdk/agent-media-payload";\ndeliverOutboundPayloads();',
    "src/infra/outbound/deliver.ts": "deliverOutboundPayloads();",
    "src/a.test.ts": "deliverOutboundPayloads();",
  })) {
    const filePath = path.join(fixtureRoot, repoPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, source);
  }
  const accountingPath = path.join(fixtureRoot, "account-source-io.mjs");
  fs.writeFileSync(
    accountingPath,
    `import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const counts = { files: {}, directories: {} };
for (const [method, kind] of [["readFileSync", "files"], ["readdirSync", "directories"]]) {
  const original = fs[method];
  fs[method] = function (file, ...args) {
    const result = original.call(this, file, ...args);
    const relative = typeof file === "string" ? path.relative(process.cwd(), file).split(path.sep).join("/") : "";
    if (/^(src|extensions|packages)(\\/|$)/.test(relative)) {
      counts[kind][relative] = (counts[kind][relative] ?? 0) + 1;
    }
    return result;
  };
}
syncBuiltinESMExports();
process.on("exit", () => fs.writeFileSync("source-io.json", JSON.stringify(counts)));
`,
  );
  const rules =
    "message-api facade-internal-imports extension-plugin-sdk-compat-subpaths plugin-sdk-compat-subpaths".split(
      " ",
    );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(accountingPath).href,
      fileURLToPath(new URL("../../scripts/check-deprecated-api-usage.mts", import.meta.url)),
      ...rules.map((id) => `--rule=${id}`),
    ],
    { cwd: fixtureRoot, encoding: "utf8" },
  );
  const io: { files: Record<string, number>; directories: Record<string, number> } = JSON.parse(
    fs.readFileSync(path.join(fixtureRoot, "source-io.json"), "utf8"),
  );

  expect(result).toMatchObject({
    status: 1,
    stdout: "",
    stderr:
      [
        "Deprecated API usage guard failed:",
        `- plugin-sdk-compat-subpaths: src/a.ts:1: ${inbound} (${migration})`,
        `- plugin-sdk-compat-subpaths: src/a.ts:2: @${inbound} (${migration})`,
        `- plugin-sdk-compat-subpaths: packages/a.ts:1: openclaw/plugin-sdk/agent-media-payload (${migration})`,
        `- extension-plugin-sdk-compat-subpaths: extensions/probe/src/a.ts:1: ${inbound} (extensions must ${migration})`,
        `- facade-internal-imports: src/a.ts:1: ${inbound} (${facade})`,
        `- facade-internal-imports: src/a.ts:2: @${inbound} (${facade})`,
        `- facade-internal-imports: extensions/probe/src/a.ts:1: ${inbound} (${facade})`,
        `- message-api: src/a.ts:3: ${message}`,
        `- message-api: extensions/probe/src/a.ts:2: ${message}`,
        `- message-api: packages/a.ts:2: ${message}`,
      ].join("\n") + "\n",
  });
  expect(io).toEqual({
    files: onceEach(
      "src/a.ts src/infra/outbound/deliver.ts packages/a.ts extensions/probe/src/a.ts",
    ),
    directories: onceEach(
      "src src/infra src/infra/outbound packages extensions extensions/probe extensions/probe/src",
    ),
  });
});
