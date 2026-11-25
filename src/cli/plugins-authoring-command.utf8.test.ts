import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  collectPluginsValidationResult,
  runPluginsBuildCommand,
} from "./plugins-authoring-command.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createProject() {
  const root = tempDirs.make("openclaw-plugin-authoring-utf8-");
  const filePath = (name: string) => path.join(root, name);
  const read = (name: string) => fs.readFileSync(filePath(name));
  const write = (name: string, value: unknown) =>
    fs.writeFileSync(filePath(name), JSON.stringify(value));
  write("package.json", {
    name: "openclaw-plugin-utf8-test",
    version: "1.0.0",
    type: "module",
    openclaw: { extensions: ["./index.ts"] },
  });
  fs.writeFileSync(
    filePath("index.ts"),
    `import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
export default defineToolPlugin({
  id: "utf8-test", name: "UTF-8 test", description: "Synthetic test plugin.",
  tools: () => [],
});`,
  );
  await runPluginsBuildCommand({ root });
  return { root, filePath, read, snapshot: () => files.map(read) };
}

const files = ["package.json", "openclaw.plugin.json"] as const;

it.skipIf(process.platform === "win32").each([
  ["device", "package.json"],
  ["FIFO", "package.json"],
  ["FIFO", "openclaw.plugin.json"],
] as const)("rejects a %s %s without rewriting metadata", async (kind, file) => {
  const { root, filePath, read } = await createProject();
  const target = filePath(file);
  const other = file === files[0] ? files[1] : files[0];
  const before = read(other);
  fs.unlinkSync(target);
  if (kind === "device") {
    fs.symlinkSync("/dev/null", target);
  } else {
    execFileSync("mkfifo", [target]);
  }

  await expect(runPluginsBuildCommand({ root })).rejects.toThrow(/regular file/);
  const stat = fs.lstatSync(target);
  expect(kind === "device" ? stat.isSymbolicLink() : stat.isFIFO()).toBe(true);
  expect(read(other)).toEqual(before);
});

it.each(files)("rejects malformed %s unchanged, then preserves repaired Unicode", async (file) => {
  const { root, filePath, read, snapshot } = await createProject();
  // Keep otherwise-valid metadata so decoding, not JSON parsing, rejects the file.
  const raw = JSON.stringify(JSON.parse(read(file).toString("utf8")));
  fs.writeFileSync(
    filePath(file),
    Buffer.concat([Buffer.from(raw.slice(0, -1)), Buffer.from(',"proofText":"\xff"}', "latin1")]),
  );
  const before = snapshot();

  await expect(runPluginsBuildCommand({ root })).rejects.toThrow("must be valid UTF-8");
  expect(snapshot()).toEqual(before);
  await expect(collectPluginsValidationResult({ root })).rejects.toThrow("must be valid UTF-8");
  expect(snapshot()).toEqual(before);
  const document = JSON.parse(raw);
  fs.writeFileSync(
    filePath(file),
    JSON.stringify({ ...document, proofText: "合法 � 😀" }) + "\r\n",
  );

  await runPluginsBuildCommand({ root });
  expect(JSON.parse(read(file).toString("utf8")).proofText).toBe("合法 � 😀");
  expect(await collectPluginsValidationResult({ root })).toMatchObject({ valid: true });
});
