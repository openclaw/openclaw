import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];
const scriptPath = "scripts/package-mac-app.sh";

function makePlist(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openclaw-plistbuddy-"));
  tempDirs.push(dir);
  const plist = path.join(dir, "Info.plist");
  writeFileSync(
    plist,
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      "<dict>",
      "<key>CFBundleIdentifier</key>",
      "<string>old.bundle</string>",
      "</dict>",
      "</plist>",
      "",
    ].join("\n"),
    "utf8",
  );
  return plist;
}

function runHelper(script: string) {
  return spawnSync("bash", ["-lc", script], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("package-mac-app plist stamping", () => {
  it("fails closed when required bundled resources are missing", () => {
    const script = readFileSync(scriptPath, "utf8");
    const modelCatalogBlock = script.slice(
      script.indexOf('MODEL_CATALOG_SRC="$ROOT_DIR/node_modules/@earendil-works/pi-ai/dist/models.generated.js"'),
      script.indexOf('echo "📦 Copying Control UI assets"'),
    );
    const openClawKitBlock = script.slice(
      script.indexOf('OPENCLAWKIT_BUNDLE="$(build_path_for_arch "$PRIMARY_ARCH")/$BUILD_CONFIG/OpenClawKit_OpenClawKit.bundle"'),
      script.indexOf('echo "📦 Copying Textual resources"'),
    );

    expect(modelCatalogBlock).toContain("ERROR: model catalog missing");
    expect(modelCatalogBlock).toContain("exit 1");
    expect(modelCatalogBlock).not.toContain("WARN:");
    expect(modelCatalogBlock).not.toContain("continuing");
    expect(openClawKitBlock).toContain("ERROR: OpenClawKit resource bundle not found");
    expect(openClawKitBlock).toContain("exit 1");
    expect(openClawKitBlock).not.toContain("WARN:");
    expect(openClawKitBlock).not.toContain("continuing");
  });

  it("does not mask required Info.plist stamp failures", () => {
    const script = readFileSync(scriptPath, "utf8");
    const stampBlock = script.slice(
      script.indexOf("plist_set_string_required"),
      script.indexOf('echo "🚚 Copying binary"'),
    );

    expect(stampBlock).toContain("plist_set_string_required");
    expect(stampBlock).not.toContain("|| true");
  });

  it.runIf(process.platform === "darwin")(
    "sets required strings and fails when the plist cannot be stamped",
    () => {
      const plist = makePlist();
      const result = runHelper(`
        set -euo pipefail
        source scripts/lib/plistbuddy.sh
        plist_set_string_required ${JSON.stringify(plist)} CFBundleIdentifier 'ai.openclaw.test'
        /usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' ${JSON.stringify(plist)}
        broken="$(mktemp -d)"
        plist_set_string_required "$broken" CFBundleIdentifier broken
      `);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("ai.openclaw.test");
      expect(result.stderr).toContain("Error Reading File");
    },
  );

  it.runIf(process.platform === "darwin")("adds optional strings and booleans", () => {
    const plist = makePlist();
    const result = runHelper(`
      set -euo pipefail
      source scripts/lib/plistbuddy.sh
      plist_set_or_add_string ${JSON.stringify(plist)} SUFeedURL ''
      plist_set_or_add_string ${JSON.stringify(plist)} SUPublicEDKey 'key"with\\\\slashes'
      plist_set_or_add_bool ${JSON.stringify(plist)} SUEnableAutomaticChecks false
      /usr/libexec/PlistBuddy -c 'Print :SUFeedURL' ${JSON.stringify(plist)}
      /usr/libexec/PlistBuddy -c 'Print :SUPublicEDKey' ${JSON.stringify(plist)}
      /usr/libexec/PlistBuddy -c 'Print :SUEnableAutomaticChecks' ${JSON.stringify(plist)}
    `);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('key"with\\\\slashes');
    expect(result.stdout).toContain("false");
  });
});
