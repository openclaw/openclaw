// Covers OpenClaw's default fs-safe native helper configuration.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";

const { configureFsSafeNative } = vi.hoisted(() => ({
  configureFsSafeNative: vi.fn(),
}));

vi.mock("@openclaw/fs-safe/config", () => ({
  configureFsSafeNative,
}));

async function importDefaults(env: Record<string, string | undefined> = {}) {
  vi.resetModules();
  await withEnvAsync(
    {
      FS_SAFE_NATIVE_MODE: undefined,
      OPENCLAW_FS_SAFE_NATIVE_MODE: undefined,
      openclaw_fs_safe_native_mode: undefined,
      FS_SAFE_PYTHON_MODE: undefined,
      OPENCLAW_FS_SAFE_PYTHON_MODE: undefined,
      FS_SAFE_PYTHON: undefined,
      OPENCLAW_FS_SAFE_PYTHON: undefined,
      OPENCLAW_PINNED_PYTHON: undefined,
      OPENCLAW_PINNED_WRITE_PYTHON: undefined,
    },
    // Apply overrides after clearing aliases; Windows env names are case-insensitive.
    () => withEnvAsync(env, () => import("./fs-safe-defaults.js")),
  );
}

describe("fs-safe defaults", () => {
  afterEach(() => {
    configureFsSafeNative.mockReset();
  });

  it.each(["darwin", "linux"] as const)(
    "disables the native helper by default on %s",
    async (platform) => {
      vi.spyOn(process, "platform", "get").mockReturnValue(platform);
      await importDefaults();

      expect(configureFsSafeNative).toHaveBeenCalledWith({ mode: "off" });
    },
  );

  it("retains native auto selection for Windows descriptor ACL checks", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await importDefaults();

    expect(configureFsSafeNative).not.toHaveBeenCalled();
  });

  it.each(["FS_SAFE_NATIVE_MODE", "OPENCLAW_FS_SAFE_NATIVE_MODE"])(
    "preserves explicit Windows native off through %s",
    async (key) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      await importDefaults({ [key]: "off" });

      expect(configureFsSafeNative).not.toHaveBeenCalled();
    },
  );

  it("lets fs-safe env mode overrides opt back into the helper", async () => {
    await importDefaults({ FS_SAFE_NATIVE_MODE: "require" });

    expect(configureFsSafeNative).not.toHaveBeenCalled();
  });

  it("honors the OpenClaw-specific env mode override", async () => {
    await importDefaults({ OPENCLAW_FS_SAFE_NATIVE_MODE: "auto" });

    expect(configureFsSafeNative).not.toHaveBeenCalled();
  });

  it("honors case-insensitive mode overrides on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    await importDefaults({ openclaw_fs_safe_native_mode: "require" });

    expect(configureFsSafeNative).not.toHaveBeenCalled();
  });

  it("lets fs-safe migrate legacy require mode without overriding it", async () => {
    await importDefaults({ OPENCLAW_FS_SAFE_PYTHON_MODE: "require" });

    expect(configureFsSafeNative).not.toHaveBeenCalled();
  });

  it("does not treat a retired interpreter path as a native mode override", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    await importDefaults({ OPENCLAW_FS_SAFE_PYTHON: "/usr/bin/python3" });

    expect(configureFsSafeNative).toHaveBeenCalledWith({ mode: "off" });
  });
});
