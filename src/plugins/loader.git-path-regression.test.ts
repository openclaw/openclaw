import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { __testing } from "./loader.js";

type CreateJiti = typeof import("jiti").createJiti;

let createJitiPromise: Promise<CreateJiti> | undefined;

async function getCreateJiti() {
  createJitiPromise ??= import("jiti").then(({ createJiti }) => createJiti);
  return createJitiPromise;
}

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
  it("loads git-style package extension entries when they import plugin-sdk channel-runtime (#49806)", async () => {
    const copiedExtensionRoot = path.join(makeTempDir(), "extensions", "imessage");
    const copiedSourceDir = path.join(copiedExtensionRoot, "src");
    const copiedPluginSdkDir = path.join(copiedExtensionRoot, "plugin-sdk");
    mkdirSafe(copiedSourceDir);
    mkdirSafe(copiedPluginSdkDir);

    const jitiBaseFile = path.join(copiedSourceDir, "__jiti-base__.mjs");
    fs.writeFileSync(jitiBaseFile, "export {};\n", "utf-8");
    fs.writeFileSync(
      path.join(copiedSourceDir, "channel.runtime.ts"),
      `import { resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-runtime";
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
    const copiedChannelRuntimeShim = path.join(copiedPluginSdkDir, "channel-runtime.ts");
    fs.writeFileSync(
      copiedChannelRuntimeShim,
      `export function resolveOutboundSendDep() {
  return "shimmed";
}
`,
      "utf-8",
    );

    const copiedChannelRuntime = path.join(copiedExtensionRoot, "src", "channel.runtime.ts");
    const jitiBaseUrl = pathToFileURL(jitiBaseFile).href;
    const createJiti = await getCreateJiti();
    const withoutAlias = createJiti(jitiBaseUrl, {
      ...__testing.buildPluginLoaderJitiOptions({}),
      tryNative: false,
    });
    // The production loader uses sync Jiti evaluation, so this regression test
    // should exercise the same seam instead of Jiti's async import helper.
    expect(() => withoutAlias(copiedChannelRuntime)).toThrow();

    const withAlias = createJiti(jitiBaseUrl, {
      ...__testing.buildPluginLoaderJitiOptions({
        "openclaw/plugin-sdk/channel-runtime": copiedChannelRuntimeShim,
      }),
      tryNative: false,
    });
    expect(withAlias(copiedChannelRuntime)).toMatchObject({
      copiedRuntimeMarker: {
        PAIRING_APPROVED_MESSAGE: "paired",
        resolveOutboundSendDep: expect.any(Function),
      },
    });
  });
});
