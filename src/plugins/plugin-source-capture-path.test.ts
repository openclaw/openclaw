import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { mkdtempPluginCaptureSync } from "./plugin-source-capture-path.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("creates Windows captures through the extended-length namespace", () => {
  // Rehearsal roots put this template past CreateDirectoryW's 248-character limit.
  const prefix = `C:\\Users\\runneradmin\\${"rehearsal\\".repeat(20)}captures\\openclaw-plugin-build-`;
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const mkdtemp = vi
    .spyOn(fs, "mkdtempSync")
    .mockImplementation((template) => `${String(template)}AbC123`);

  expect(mkdtempPluginCaptureSync(prefix)).toBe(`${prefix}AbC123`);
  expect(mkdtemp).toHaveBeenCalledWith(`\\\\?\\${prefix}`);
});

it("returns UNC captures in their ordinary spelling", () => {
  const prefix = "\\\\server\\share\\state\\openclaw-plugin-build-";
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const mkdtemp = vi
    .spyOn(fs, "mkdtempSync")
    .mockImplementation((template) => `${String(template)}AbC123`);

  expect(mkdtempPluginCaptureSync(prefix)).toBe(`${prefix}AbC123`);
  expect(mkdtemp).toHaveBeenCalledWith("\\\\?\\UNC\\server\\share\\state\\openclaw-plugin-build-");
});
