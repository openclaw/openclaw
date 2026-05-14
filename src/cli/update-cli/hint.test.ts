import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateHintCommand } from "./hint.js";

vi.mock("../../config/paths.js", () => ({
  resolveStateDir: () => tmpDir,
}));

vi.mock("../../version.js", () => ({
  VERSION: "2026.3.28",
}));

const logSpy = vi.fn<(msg: string) => void>();
const writeJsonSpy = vi.fn<(data: unknown) => void>();

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: (...args: unknown[]) => logSpy(args[0] as string),
    writeJson: (...args: unknown[]) => writeJsonSpy(args[0]),
  },
}));

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(import.meta.dirname ?? "/tmp", "hint-test-"));
  logSpy.mockClear();
  writeJsonSpy.mockClear();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("updateHintCommand", () => {
  it("prints nothing when no state file exists", async () => {
    await updateHintCommand({});
    expect(logSpy).not.toHaveBeenCalled();
    expect(writeJsonSpy).not.toHaveBeenCalled();
  });

  it("prints nothing when state file has no available version", async () => {
    await fs.writeFile(
      path.join(tmpDir, "update-check.json"),
      JSON.stringify({ lastCheckedAt: "2026-04-01T00:00:00.000Z" }),
    );
    await updateHintCommand({});
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("prints nothing when already up to date", async () => {
    await fs.writeFile(
      path.join(tmpDir, "update-check.json"),
      JSON.stringify({
        lastAvailableVersion: "2026.3.28",
        lastAvailableTag: "latest",
      }),
    );
    await updateHintCommand({});
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("prints upgrade hint when a newer version is available", async () => {
    await fs.writeFile(
      path.join(tmpDir, "update-check.json"),
      JSON.stringify({
        lastAvailableVersion: "2026.4.1",
        lastAvailableTag: "latest",
      }),
    );
    await updateHintCommand({});
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy.mock.calls[0]?.[0]).toMatch(/UPGRADE_AVAILABLE/);
    expect(logSpy.mock.calls[0]?.[0]).toContain("2026.3.28");
    expect(logSpy.mock.calls[0]?.[0]).toContain("2026.4.1");
    expect(logSpy.mock.calls[0]?.[0]).toContain("openclaw update");
  });

  it("outputs JSON when --json is passed", async () => {
    await fs.writeFile(
      path.join(tmpDir, "update-check.json"),
      JSON.stringify({
        lastAvailableVersion: "2026.4.1",
        lastAvailableTag: "beta",
      }),
    );
    await updateHintCommand({ json: true });
    expect(writeJsonSpy).toHaveBeenCalledOnce();
    expect(writeJsonSpy.mock.calls[0]?.[0]).toEqual({
      updateAvailable: true,
      currentVersion: "2026.3.28",
      latestVersion: "2026.4.1",
      channel: "beta",
    });
  });

  it("prints nothing when local version is newer", async () => {
    await fs.writeFile(
      path.join(tmpDir, "update-check.json"),
      JSON.stringify({
        lastAvailableVersion: "2026.3.1",
        lastAvailableTag: "latest",
      }),
    );
    await updateHintCommand({});
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("handles corrupt JSON gracefully", async () => {
    await fs.writeFile(path.join(tmpDir, "update-check.json"), "not json{{{");
    await updateHintCommand({});
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("emits JSON false when no state file and --json", async () => {
    await updateHintCommand({ json: true });
    expect(writeJsonSpy).toHaveBeenCalledOnce();
    expect(writeJsonSpy.mock.calls[0]?.[0]).toEqual({ updateAvailable: false });
  });

  it("handles non-string version field gracefully", async () => {
    await fs.writeFile(
      path.join(tmpDir, "update-check.json"),
      JSON.stringify({ lastAvailableVersion: 12345 }),
    );
    await updateHintCommand({});
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("emits JSON false when version field is non-string and --json", async () => {
    await fs.writeFile(
      path.join(tmpDir, "update-check.json"),
      JSON.stringify({ lastAvailableVersion: { nested: true } }),
    );
    await updateHintCommand({ json: true });
    expect(writeJsonSpy).toHaveBeenCalledOnce();
    expect(writeJsonSpy.mock.calls[0]?.[0]).toEqual({ updateAvailable: false });
  });

  it("handles JSON null root gracefully", async () => {
    await fs.writeFile(path.join(tmpDir, "update-check.json"), "null");
    await updateHintCommand({});
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("emits JSON false when root is not an object and --json", async () => {
    await fs.writeFile(path.join(tmpDir, "update-check.json"), "42");
    await updateHintCommand({ json: true });
    expect(writeJsonSpy).toHaveBeenCalledOnce();
    expect(writeJsonSpy.mock.calls[0]?.[0]).toEqual({ updateAvailable: false });
  });

  it("emits JSON false when already up to date and --json", async () => {
    await fs.writeFile(
      path.join(tmpDir, "update-check.json"),
      JSON.stringify({
        lastAvailableVersion: "2026.3.28",
        lastAvailableTag: "latest",
      }),
    );
    await updateHintCommand({ json: true });
    expect(writeJsonSpy).toHaveBeenCalledOnce();
    expect(writeJsonSpy.mock.calls[0]?.[0]).toEqual({ updateAvailable: false });
  });
});
