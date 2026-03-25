import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempRoots: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-loader-"));
  tempRoots.push(dir);
  return dir;
}

function mkdirSafe(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("plugin loader git path regression", () => {
  it("loads git-style package extension entries when they import plugin-sdk infra-runtime (#49806)", async () => {
    const copiedExtensionRoot = path.join(makeTempDir(), "extensions", "imessage");
    const copiedSourceDir = path.join(copiedExtensionRoot, "src");
    const copiedPluginSdkDir = path.join(copiedExtensionRoot, "plugin-sdk");
    mkdirSafe(copiedSourceDir);
    mkdirSafe(copiedPluginSdkDir);
    const jitiBaseFile = path.join(copiedSourceDir, "__jiti-base__.mjs");
    fs.writeFileSync(jitiBaseFile, "export {};\n", "utf-8");
    fs.writeFileSync(
      path.join(copiedSourceDir, "channel.runtime.ts"),
      `import { resolveOutboundSendDep } from "openclaw/plugin-sdk/infra-runtime";
import { PAIRING_APPROVED_MESSAGE } from "../runtime-api.js";

export const copiedRuntimeMarker = {
  resolveOutboundSendDep,
  PAIRING_APPROVED_MESSAGE,
};
`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(copiedExtensionRoot, "runtime-api.ts"),
      `export const PAIRING_APPROVED_MESSAGE = "paired";
`,
      "utf-8",
    );
    const copiedChannelRuntimeShim = path.join(copiedPluginSdkDir, "infra-runtime.ts");
    fs.writeFileSync(
      copiedChannelRuntimeShim,
      `export function resolveOutboundSendDep() {
  return "shimmed";
}
`,
      "utf-8",
    );
    const copiedChannelRuntime = path.join(copiedExtensionRoot, "src", "channel.runtime.ts");
    const script = `
      import { createJiti } from "jiti";
      const withoutAlias = createJiti(${JSON.stringify(jitiBaseFile)}, {
        interopDefault: true,
        tryNative: false,
        extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
      });
      let withoutAliasThrew = false;
      try {
        withoutAlias(${JSON.stringify(copiedChannelRuntime)});
      } catch {
        withoutAliasThrew = true;
      }
      const withAlias = createJiti(${JSON.stringify(jitiBaseFile)}, {
        interopDefault: true,
        tryNative: false,
        extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
        alias: {
          "openclaw/plugin-sdk/infra-runtime": ${JSON.stringify(copiedChannelRuntimeShim)},
        },
      });
      const mod = withAlias(${JSON.stringify(copiedChannelRuntime)});
      console.log(JSON.stringify({
        withoutAliasThrew,
        marker: mod.copiedRuntimeMarker?.PAIRING_APPROVED_MESSAGE,
        dep: mod.copiedRuntimeMarker?.resolveOutboundSendDep?.(),
      }));
    `;
    const raw = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf-8",
    });
    const result = JSON.parse(raw) as {
      withoutAliasThrew: boolean;
      marker?: string;
      dep?: string;
    };
    expect(result.withoutAliasThrew).toBe(true);
    expect(result.marker).toBe("paired");
    expect(result.dep).toBe("shimmed");
  });
});
