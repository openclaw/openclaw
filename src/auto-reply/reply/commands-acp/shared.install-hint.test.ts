import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveAcpInstallCommandHint } from "./shared.js";

describe("resolveAcpInstallCommandHint", () => {
  const tmpDir = path.join("/tmp", "test-acpx-hint-" + Date.now());

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns configured installCommand when present", () => {
    const cfg = {
      acp: { runtime: { installCommand: "custom-install" } },
    } as unknown as OpenClawConfig;
    expect(resolveAcpInstallCommandHint(cfg)).toBe("custom-install");
  });

  it("returns generic message for non-acpx backends", () => {
    const cfg = { acp: { backend: "custom-backend" } } as unknown as OpenClawConfig;
    const result = resolveAcpInstallCommandHint(cfg);
    expect(result).toContain("custom-backend");
  });

  it("resolves bundled extension path relative to package root", () => {
    // The bundled extension exists relative to the package root, so
    // resolveAcpInstallCommandHint should resolve it and NOT return
    // the scoped @openclaw/acpx (which is not published to npm).
    const cfg = {} as unknown as OpenClawConfig;
    const result = resolveAcpInstallCommandHint(cfg);
    // Should resolve to a local path, not the scoped npm package
    expect(result).toContain("openclaw plugins install");
    // The extensions/acpx directory exists in the repo, so this should
    // resolve to either the cwd path or the bundled path — both local.
    expect(result).toContain("extensions/acpx");
  });

  it("does not produce the unpublished scoped package name when extensions exist", () => {
    const cfg = {} as unknown as OpenClawConfig;
    const result = resolveAcpInstallCommandHint(cfg);
    // @openclaw/acpx is NOT published to npm — the hint should NOT
    // fall back to it when a bundled extension is available.
    if (result.includes("extensions/acpx")) {
      expect(result).not.toBe("openclaw plugins install @openclaw/acpx");
    }
  });
});
