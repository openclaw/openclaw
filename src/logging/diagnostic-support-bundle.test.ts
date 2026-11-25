import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  jsonSupportBundleFile,
  textSupportBundleFile,
  writeSupportBundleDirectory,
  writeSupportBundleZip,
} from "./diagnostic-support-bundle.js";

let tempDir: string;
let outputPath: string;
const writeZip = (ok = true) =>
  writeSupportBundleZip({ outputPath, files: [jsonSupportBundleFile("manifest.json", { ok })] });
async function expectZip() {
  expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  expect(await zip.file("manifest.json")?.async("string")).toBe('{\n  "ok": true\n}\n');
  expect(fs.readdirSync(tempDir)).toEqual(["bundle.zip"]);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-support-bundle-"));
  outputPath = path.join(tempDir, "bundle.zip");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

it("writes directory bundles with restrictive file permissions and byte inventory", async () => {
  const outputDir = path.join(tempDir, "bundle");
  const contents = await writeSupportBundleDirectory({
    outputDir,
    files: [
      jsonSupportBundleFile("manifest.json", { ok: true }),
      textSupportBundleFile("nested/summary.md", "hello"),
    ],
  });

  expect(contents).toEqual([
    { path: "manifest.json", mediaType: "application/json", bytes: 17 },
    { path: "nested/summary.md", mediaType: "text/plain; charset=utf-8", bytes: 6 },
  ]);
  expect(fs.statSync(path.join(outputDir, "manifest.json")).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.join(outputDir, "nested", "summary.md")).mode & 0o777).toBe(0o600);
});

it("rejects absolute and traversal bundle paths", async () => {
  expect(() => jsonSupportBundleFile("../escape.json", {})).toThrow(/Invalid bundle/u);
  expect(() => textSupportBundleFile("/tmp/escape.txt", "nope")).toThrow(/Invalid bundle/u);

  await expect(
    writeSupportBundleZip({
      outputPath,
      files: [{ path: "nested/../escape.txt", mediaType: "text/plain", content: "nope" }],
    }),
  ).rejects.toThrow(/Invalid bundle/u);
});

it.each([false, true])("publishes a private zip (replacing=%s)", async (replacing) => {
  if (replacing) {
    fs.writeFileSync(outputPath, "previous export");
    fs.chmodSync(outputPath, 0o644);
  }
  const published = await writeZip();

  expect(published.path).toBe(outputPath);
  expect(published.bytes).toBeGreaterThan(0);
  await expectZip();
});

it("keeps the previous export when publication fails", async () => {
  await writeZip();
  const priorBytes = fs.readFileSync(outputPath);

  const writeFileSpy = vi.spyOn(fsp, "writeFile").mockImplementationOnce(async (file) => {
    expect(typeof file).toBe("string");
    fs.writeFileSync(file as string, "partial replacement");
    throw new Error("injected write failure");
  });
  try {
    await expect(writeZip(false)).rejects.toThrow("injected write failure");
  } finally {
    writeFileSpy.mockRestore();
  }

  expect(fs.readFileSync(outputPath)).toEqual(priorBytes);
  expect(fs.readdirSync(tempDir)).toEqual(["bundle.zip"]);
});
