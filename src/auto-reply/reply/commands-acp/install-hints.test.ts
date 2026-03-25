import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveAcpInstallCommandHint, resolveConfiguredAcpBackendId } from "./install-hints.js";

const tempDirs: string[] = [];

function withAcpConfig(acp: OpenClawConfig["acp"]): OpenClawConfig {
  return { acp } as OpenClawConfig;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ACP install hints", () => {
  it("prefers explicit runtime install command", () => {
    const cfg = withAcpConfig({
      runtime: { installCommand: "pnpm openclaw plugins install acpx" },
    });
    expect(resolveAcpInstallCommandHint(cfg)).toBe("pnpm openclaw plugins install acpx");
  });

  it("uses local acpx extension path when present", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-install-hint-"));
    tempDirs.push(tempRoot);
    fs.mkdirSync(path.join(tempRoot, "extensions", "acpx"), { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(tempRoot);

    const cfg = withAcpConfig({ backend: "acpx" });
    const hint = resolveAcpInstallCommandHint(cfg);
    expect(hint).toContain("openclaw plugins install ");
    expect(hint).toContain(path.join("extensions", "acpx"));
  });

  it("falls back to scoped install hint for acpx when local extension is absent", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-install-hint-"));
    tempDirs.push(tempRoot);
    vi.spyOn(process, "cwd").mockReturnValue(tempRoot);

    const cfg = withAcpConfig({ backend: "acpx" });
    expect(resolveAcpInstallCommandHint(cfg)).toBe("openclaw plugins install acpx");
  });

  it("returns generic plugin hint for non-acpx backend", () => {
    const cfg = withAcpConfig({ backend: "custom-backend" });
    expect(resolveConfiguredAcpBackendId(cfg)).toBe("custom-backend");
    expect(resolveAcpInstallCommandHint(cfg)).toContain('ACP backend "custom-backend"');
  });
});
