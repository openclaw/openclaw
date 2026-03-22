import { describe, expect, it, beforeEach, vi } from "vitest";
import * as wsl from "./wsl.js";

describe("WSL detection", () => {
  beforeEach(() => {
    wsl.resetWSLStateForTests();
    vi.clearAllMocks();
  });

  describe("isWSLEnv", () => {
    it("returns true when WSL_INTEROP is set", () => {
      const original = process.env.WSL_INTEROP;
      process.env.WSL_INTEROP = "1";
      expect(wsl.isWSLEnv()).toBe(true);
      process.env.WSL_INTEROP = original;
    });

    it("returns true when WSL_DISTRO_NAME is set", () => {
      const original = process.env.WSL_DISTRO_NAME;
      process.env.WSL_DISTRO_NAME = "Ubuntu";
      expect(wsl.isWSLEnv()).toBe(true);
      process.env.WSL_DISTRO_NAME = original;
    });

    it("returns false when no WSL env vars set", () => {
      const original1 = process.env.WSL_INTEROP;
      const original2 = process.env.WSL_DISTRO_NAME;
      const original3 = process.env.WSLENV;
      delete process.env.WSL_INTEROP;
      delete process.env.WSL_DISTRO_NAME;
      delete process.env.WSLENV;
      expect(wsl.isWSLEnv()).toBe(false);
      process.env.WSL_INTEROP = original1;
      process.env.WSL_DISTRO_NAME = original2;
      process.env.WSLENV = original3;
    });
  });

  describe("isWSLSync", () => {
    it("returns false on non-linux platform", () => {
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      expect(wsl.isWSLSync()).toBe(false);
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    });
  });

  describe("isWSL2Sync", () => {
    it("returns false when not WSL", () => {
      const original = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
      expect(wsl.isWSL2Sync()).toBe(false);
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    });
  });
});
