import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureClaworksProductReady } from "./claworks-bootstrap.js";

describe("claworks-bootstrap", () => {
  it("repairs existing config in product mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-boot-"));
    const configPath = join(dir, "claworks.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        gateway: { port: 18789 },
        plugins: { allow: ["feishu"], entries: {} },
      }),
      "utf8",
    );

    const env = {
      CLAWORKS_PRODUCT: "1",
      OPENCLAW_STATE_DIR: dir,
      OPENCLAW_CONFIG_PATH: configPath,
    };

    const result = ensureClaworksProductReady({ env, initIfMissing: false });
    expect(result.robotPluginReady).toBe(true);
    const saved = JSON.parse(readFileSync(configPath, "utf8")) as {
      gateway: { port: number };
      plugins: { allow: string[] };
    };
    expect(saved.gateway.port).toBe(18800);
    expect(saved.plugins.allow).toContain("claworks-robot");
  });

  it("skips init when missing and initIfMissing false", () => {
    const dir = mkdtempSync(join(tmpdir(), "cw-boot-miss-"));
    const configPath = join(dir, "claworks.json");
    const env = {
      CLAWORKS_PRODUCT: "1",
      OPENCLAW_STATE_DIR: dir,
      OPENCLAW_CONFIG_PATH: configPath,
    };
    const result = ensureClaworksProductReady({ env, initIfMissing: false });
    expect(existsSync(configPath)).toBe(false);
    expect(result.created).toBe(false);
  });
});
