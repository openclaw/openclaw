import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  collectPluginsValidationResult,
  runPluginsBuildCommand,
} from "./plugins-authoring-command.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createProject() {
  const root = tempDirs.make("openclaw-plugin-authoring-utf8-");
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "openclaw-plugin-utf8-test",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.ts"] },
    }),
  );
  fs.writeFileSync(
    path.join(root, "index.ts"),
    `import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
export default defineToolPlugin({
  id: "utf8-test", name: "UTF-8 test", description: "Synthetic test plugin.",
  tools: tool => [tool({
    name: "echo", description: "Echo input.",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ ok: true }),
  })],
});`,
  );
  await runPluginsBuildCommand({ root });
  return root;
}

const files = ["package.json", "openclaw.plugin.json"] as const;

describe("plugin authoring JSON encoding", () => {
  it.each(files)("rejects malformed UTF-8 in %s without rewriting metadata", async (file) => {
    const root = await createProject();
    const target = path.join(root, file);
    const document = JSON.parse(fs.readFileSync(target, "utf8"));
    const raw = JSON.stringify({ ...document, proofText: "SENTINEL" });
    const at = raw.indexOf("SENTINEL");
    fs.writeFileSync(
      target,
      Buffer.concat([
        Buffer.from(raw.slice(0, at)),
        Buffer.from([0xff]),
        Buffer.from(raw.slice(at + "SENTINEL".length)),
      ]),
    );
    const before = files.map((name) => fs.readFileSync(path.join(root, name)));

    await expect(runPluginsBuildCommand({ root })).rejects.toThrow("must be valid UTF-8");
    expect(files.map((name) => fs.readFileSync(path.join(root, name)))).toEqual(before);
    await expect(collectPluginsValidationResult({ root })).rejects.toThrow("must be valid UTF-8");
    expect(files.map((name) => fs.readFileSync(path.join(root, name)))).toEqual(before);
  });

  it.each(files)("preserves valid Unicode metadata in %s", async (file) => {
    const root = await createProject();
    const target = path.join(root, file);
    const document = JSON.parse(fs.readFileSync(target, "utf8"));
    fs.writeFileSync(target, JSON.stringify({ ...document, proofText: "合法 � 😀" }) + "\r\n");

    await runPluginsBuildCommand({ root });
    expect(JSON.parse(fs.readFileSync(target, "utf8")).proofText).toBe("合法 � 😀");
    expect(await collectPluginsValidationResult({ root })).toMatchObject({ valid: true });
  });
});
