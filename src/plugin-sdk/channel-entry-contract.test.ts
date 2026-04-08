import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";
import { loadBundledEntryExportSync } from "./channel-entry-contract.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.resetModules();
  vi.doUnmock("jiti");
});

describe("loadBundledEntryExportSync", () => {
  it("includes importer and resolved path context when a bundled sidecar is missing", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-entry-contract-"));
    tempDirs.push(tempRoot);

    const pluginRoot = path.join(tempRoot, "dist", "extensions", "telegram");
    fs.mkdirSync(pluginRoot, { recursive: true });

    const importerPath = path.join(pluginRoot, "index.js");
    fs.writeFileSync(importerPath, "export default {};\n", "utf8");

    let thrown: unknown;
    try {
      loadBundledEntryExportSync(pathToFileURL(importerPath).href, {
        specifier: "./src/secret-contract.js",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('bundled plugin entry "./src/secret-contract.js" failed to open');
    expect(message).toContain(`from "${importerPath}"`);
    expect(message).toContain(`resolved "${path.join(pluginRoot, "src", "secret-contract.js")}"`);
    expect(message).toContain(`plugin root "${pluginRoot}"`);
    expect(message).toContain('reason "path"');
    expect(message).toContain("ENOENT");
  });

  it("keeps Windows dist sidecar loads off Jiti native import", async () => {
    const createJiti = vi.fn(() => vi.fn(() => ({ load: 42 })));
    vi.doMock("jiti", () => ({
      createJiti,
    }));
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      const channelEntryContract = await importFreshModule<
        typeof import("./channel-entry-contract.js")
      >(import.meta.url, "./channel-entry-contract.js?scope=windows-dist-jiti");
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-entry-contract-"));
      tempDirs.push(tempRoot);

      const pluginRoot = path.join(tempRoot, "dist", "extensions", "telegram");
      fs.mkdirSync(pluginRoot, { recursive: true });

      const importerPath = path.join(pluginRoot, "index.js");
      const helperPath = path.join(pluginRoot, "helper.ts");
      fs.writeFileSync(importerPath, "export default {};\n", "utf8");
      fs.writeFileSync(helperPath, "export const load = 42;\n", "utf8");

      expect(
        channelEntryContract.loadBundledEntryExportSync<number>(pathToFileURL(importerPath).href, {
          specifier: "./helper.ts",
          exportName: "load",
        }),
      ).toBe(42);
      expect(createJiti).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          tryNative: false,
        }),
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("falls back from src setup and secret specifiers to packaged public artifacts", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-entry-contract-"));
    tempDirs.push(tempRoot);

    const pluginRoot = path.join(tempRoot, "dist", "extensions", "telegram");
    fs.mkdirSync(pluginRoot, { recursive: true });

    const importerPath = path.join(pluginRoot, "setup-entry.js");
    const channelPluginApiPath = path.join(pluginRoot, "channel-plugin-api.js");
    const secretContractApiPath = path.join(pluginRoot, "secret-contract-api.js");
    fs.writeFileSync(importerPath, "export default {};\n", "utf8");
    fs.writeFileSync(
      channelPluginApiPath,
      "export const telegramSetupPlugin = { id: 'telegram-setup' };\n",
      "utf8",
    );
    fs.writeFileSync(
      secretContractApiPath,
      [
        "export const secretTargetRegistryEntries = ['botToken'];",
        "export function collectRuntimeConfigAssignments() { return undefined; }",
      ].join("\n"),
      "utf8",
    );

    expect(
      loadBundledEntryExportSync<{ id: string }>(pathToFileURL(importerPath).href, {
        specifier: "./src/channel.setup.js",
        exportName: "telegramSetupPlugin",
      }),
    ).toEqual({ id: "telegram-setup" });

    expect(
      loadBundledEntryExportSync<{
        secretTargetRegistryEntries: string[];
        collectRuntimeConfigAssignments: () => undefined;
      }>(pathToFileURL(importerPath).href, {
        specifier: "./src/secret-contract.js",
        exportName: "channelSecrets",
      }),
    ).toMatchObject({
      secretTargetRegistryEntries: ["botToken"],
      collectRuntimeConfigAssignments: expect.any(Function),
    });
  });
});
