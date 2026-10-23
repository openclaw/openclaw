import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  mkdtempPluginCaptureSync,
  PLUGIN_SOURCE_CAPTURE_PREFIX,
} from "./plugin-source-capture-path.js";

const temp = useAutoCleanupTempDirTracker(afterEach);

it("allocates captures beneath roots deeper than the Windows directory limit", () => {
  let parent = temp.make("plugin-capture-depth-");
  while (parent.length < 240) {
    parent = path.join(parent, "rehearsal-root");
  }
  fs.mkdirSync(parent, { recursive: true });

  const capture = mkdtempPluginCaptureSync(path.join(parent, PLUGIN_SOURCE_CAPTURE_PREFIX));
  fs.writeFileSync(path.join(capture, "index.js"), "export {};\n");

  expect(path.dirname(capture)).toBe(parent);
  expect(capture.startsWith("\\\\?\\")).toBe(false);
  expect(fs.readFileSync(path.join(capture, "index.js"), "utf8")).toBe("export {};\n");
});
