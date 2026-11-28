import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptPath = "scripts/make_appcast.sh";
const script = readFileSync(scriptPath, "utf8");

it("does not reference release notes before their path is assigned", () => {
  const setupBlock = script.slice(
    script.indexOf('TMP_DIR="$(mktemp -d)"'),
    script.indexOf('cp -f "$ZIP" "$TMP_DIR/$ZIP_NAME"'),
  );
  expect(setupBlock).toContain('NOTES_HTML=""');
  expect(setupBlock.indexOf('NOTES_HTML=""')).toBeLessThan(setupBlock.indexOf("trap cleanup EXIT"));
  expect(setupBlock).toContain(
    'if [[ -n "$NOTES_HTML" && "${KEEP_SPARKLE_NOTES:-0}" != "1" ]]; then',
  );
  expect(setupBlock).toContain('rm -f "$NOTES_HTML"');
});

it.skipIf(process.platform === "win32").each([
  ["2026.8.2", undefined],
  ["2026.8.2-beta.1", "beta"],
  ["2026.8.2.beta.1", "beta"],
  ["2026.8.33", "extended-stable"],
  ["2026.8.2-alpha.1", "refused"],
])("generates the correct Sparkle channel for %s with system Bash", (version, channel) => {
  const root = tempDirs.make("openclaw-appcast-");
  const at = (name: string) => path.join(root, name);
  mkdirSync(at("scripts"));
  const executable = (name: string, body: string) => writeFileSync(at(name), body, { mode: 0o755 });
  copyFileSync(scriptPath, at("scripts/make_appcast.sh"));
  executable("scripts/changelog-to-html.sh", "#!/bin/sh\necho '<p>Release notes</p>'\n");
  const zip = at(`OpenClaw-${version}.zip`);
  writeFileSync(zip, "fixture archive");
  writeFileSync(at("appcast.xml"), "previous feed");
  executable(
    "generate-appcast",
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.writeFileSync(path.join(__dirname, "arguments.json"), JSON.stringify(args));
// Sparkle names the feed after the app's SUFeedURL basename unless -o pins it.
const output = args.includes("-o") ? args[args.indexOf("-o") + 1] : path.join(args.at(-1), "appcast-arm64.xml");
fs.writeFileSync(output, '<rss><channel><item><sparkle:shortVersionString>${version}</sparkle:shortVersionString><enclosure sparkle:edSignature="fixture-signature" /></item></channel></rss>');
`,
  );
  const result = spawnSync("/bin/bash", [at("scripts/make_appcast.sh"), zip], {
    encoding: "utf8",
    env: {
      ...process.env,
      SPARKLE_PRIVATE_KEY_FILE: at("unused-fixture-key"),
      SPARKLE_GENERATE_APPCAST: at("generate-appcast"),
      SPARKLE_RELEASE_VERSION: version,
      KEEP_SPARKLE_NOTES: "0",
    },
  });
  if (channel === "refused") {
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Alpha releases do not ship via Sparkle");
    expect(existsSync(at("arguments.json"))).toBe(false);
    expect(readFileSync(at("appcast.xml"), "utf8")).toBe("previous feed");
    return;
  }
  expect(result.status, result.stderr).toBe(0);
  const args = JSON.parse(readFileSync(at("arguments.json"), "utf8")) as string[];
  expect(args).toContain("--embed-release-notes");
  expect(args.includes("--channel")).toBe(Boolean(channel));
  if (channel) {
    expect(args[args.indexOf("--channel") + 1]).toBe(channel);
  }
  expect(args).not.toContain("");
  expect(args[args.indexOf("-o") + 1]).toBe(path.join(args.at(-1) ?? "", "appcast.xml"));
  expect(readFileSync(at("appcast.xml"), "utf8")).toContain(
    `<sparkle:shortVersionString>${version}</sparkle:shortVersionString>`,
  );
  expect(existsSync(at(`OpenClaw-${version}.html`))).toBe(false);
});

it("prefers the host-architecture Sparkle tool and requires a signed entry", () => {
  expect(script).toContain('if [[ -n "${SPARKLE_GENERATE_APPCAST:-}" ]]');
  expect(script).toContain('"$ROOT/apps/macos/.build/$host_arch"');
  expect(script).toContain('if [[ -d "$bundled_root" ]]');
  expect(script.indexOf('"$ROOT/apps/macos/.build/$host_arch"')).toBeLessThan(
    script.indexOf("command -v generate_appcast"),
  );
  expect(script).toContain("is missing sparkle:edSignature");
});

function deltaFixture(mode = "valid") {
  const root = tempDirs.make("openclaw-appcast-delta-");
  const at = (name: string) => path.join(root, name);
  mkdirSync(at("scripts"));
  copyFileSync(scriptPath, at("scripts/make_appcast.sh"));
  writeFileSync(at("scripts/changelog-to-html.sh"), "#!/bin/sh\necho '<p>Notes</p>'\n", {
    mode: 0o755,
  });
  writeFileSync(at("appcast.xml"), "production feed must stay unchanged");
  writeFileSync(at("OpenClaw-2026.11.1-arm64.zip"), "new full archive");
  writeFileSync(at("OpenClaw-2026.10.10-arm64.zip"), "previous full archive");
  writeFileSync(
    at("generate-appcast"),
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs"); const path = require("node:path");',
      "const args = process.argv.slice(2); const dir = args.at(-1);",
      'if (!fs.existsSync(path.join(dir, "OpenClaw-2026.10.10-arm64.zip"))) throw Error("missing base");',
      'if (args[args.indexOf("--maximum-deltas") + 1] !== "1") throw Error("unbounded deltas");',
      "const mode = process.env.FIXTURE_DELTA_MODE;",
      'if (mode !== "missing") fs.writeFileSync(path.join(dir, "OpenClaw-new-old.delta"), "patch");',
      'const sig = mode === "unsigned" ? "" : \' sparkle:edSignature="delta-signature"\';',
      'const delta = mode === "none" ? "" : \'<sparkle:deltas><enclosure url="https://example.invalid/OpenClaw-new-old.delta" length="5" sparkle:deltaFrom="1"\' + sig + \'/></sparkle:deltas>\';',
      'fs.writeFileSync(args[args.indexOf("-o") + 1], \'<rss><channel><item><sparkle:shortVersionString>2026.11.1</sparkle:shortVersionString><enclosure url="https://example.invalid/OpenClaw-2026.11.1-arm64.zip" length="16" sparkle:edSignature="full-signature"/>\' + delta + \'</item></channel></rss>\');',
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  const run = (extra: string[] = []) =>
    spawnSync(
      "/bin/bash",
      [
        at("scripts/make_appcast.sh"),
        at("OpenClaw-2026.11.1-arm64.zip"),
        "https://example.invalid/appcast.xml",
        "--delta-from",
        at("OpenClaw-2026.10.10-arm64.zip"),
        ...extra,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          SPARKLE_PRIVATE_KEY_FILE: at("fixture-key"),
          SPARKLE_GENERATE_APPCAST: at("generate-appcast"),
          SPARKLE_RELEASE_VERSION: "2026.11.1",
          SPARKLE_DOWNLOAD_URL_PREFIX: "https://example.invalid/",
          FIXTURE_DELTA_MODE: mode,
        },
      },
    );
  return { at, run };
}

it.skipIf(process.platform === "win32").each(["valid", "none"])(
  "exports isolated %s delta artifacts without changing the production feed",
  (mode) => {
    const { at, run } = deltaFixture(mode);
    const result = run(["--output-dir", at("output")]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(at("appcast.xml"), "utf8")).toBe("production feed must stay unchanged");
    expect(readFileSync(at("output/OpenClaw-2026.11.1-arm64.zip"), "utf8")).toBe(
      "new full archive",
    );
    expect(existsSync(at("output/OpenClaw-new-old.delta"))).toBe(mode === "valid");
    expect(existsSync(at("output/OpenClaw-2026.10.10-arm64.zip"))).toBe(false);
    expect(readFileSync(at("output/appcast.xml"), "utf8")).toContain("full-signature");
  },
);

it.skipIf(process.platform === "win32").each(["unsigned", "missing"])(
  "refuses %s delta artifacts before exporting a feed",
  (mode) => {
    const { at, run } = deltaFixture(mode);
    const result = run(["--output-dir", at("output")]);
    expect(result.status).not.toBe(0);
    expect(existsSync(at("output/appcast.xml"))).toBe(false);
    expect(readFileSync(at("appcast.xml"), "utf8")).toBe("production feed must stay unchanged");
  },
);

it.skipIf(process.platform === "win32")(
  "requires an isolated output directory for delta generation",
  () => {
    const { at, run } = deltaFixture();
    expect(run().status).not.toBe(0);
    expect(readFileSync(at("appcast.xml"), "utf8")).toBe("production feed must stay unchanged");
  },
);

it.skipIf(process.platform === "win32")("does not overwrite an existing experiment", () => {
  const { at, run } = deltaFixture();
  mkdirSync(at("output"));
  writeFileSync(at("output/appcast.xml"), "retained feed");
  expect(run(["--output-dir", at("output")]).status).not.toBe(0);
  expect(readFileSync(at("output/appcast.xml"), "utf8")).toBe("retained feed");
});
