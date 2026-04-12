import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("jiti");
  vi.doUnmock("node:fs");
  vi.doUnmock("node:module");
  vi.doUnmock("node:url");
  vi.doUnmock("../infra/boundary-file-read.js");
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.resetModules();
  vi.doUnmock("jiti");
  vi.unstubAllEnvs();
});

describe("loadBundledEntryExportSync", () => {
  it("converts Windows absolute paths to file URLs before handing them to jiti", async () => {
    const importerUrl = "file:///C:/openclaw/dist/extensions/signal/setup-entry.js";
    const importerPath = fileURLToPath(importerUrl);
    const resolvedAbsolutePath = path.resolve(path.dirname(importerPath), "./api.js");
    const modulePath = String.raw`C:\openclaw\dist\extensions\signal\api.js`;
    const safeImportPath = "file:///C:/openclaw/dist/extensions/signal/api.js";

    const loader = vi.fn().mockReturnValue({ signalSetupPlugin: {} });
    vi.doMock("jiti", () => ({
      createJiti: vi.fn(() => loader),
    }));
    vi.doMock("node:module", () => ({
      createRequire: vi.fn(() => () => {
        throw new Error("force jiti fallback");
      }),
    }));
    vi.doMock("node:fs", () => ({
      default: {
        closeSync: vi.fn(),
      },
    }));
    vi.doMock("node:url", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:url")>();
      return {
        ...actual,
        pathToFileURL: vi.fn((value: string) =>
          value === modulePath ? new URL(safeImportPath) : actual.pathToFileURL(value),
        ),
      };
    });
    vi.doMock("../infra/boundary-file-read.js", () => ({
      openBoundaryFileSync: vi.fn(({ absolutePath }: { absolutePath: string }) => ({
        ok: true,
        fd: 1,
        path: absolutePath === resolvedAbsolutePath ? modulePath : absolutePath,
      })),
    }));

    const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platformDescriptor?.configurable) {
      throw new Error("process.platform is not configurable in this test environment");
    }
    Object.defineProperty(process, "platform", { value: "win32" });

    try {
      const { loadBundledEntryExportSync } = await importFreshModule<
        typeof import("./channel-entry-contract.js")
      >(import.meta.url, "./channel-entry-contract.js?scope=windows-safe-import-path");
      loadBundledEntryExportSync(importerUrl, {
        specifier: "./api.js",
        exportName: "signalSetupPlugin",
      });
      expect(loader).toHaveBeenCalledOnce();
      expect(loader).toHaveBeenCalledWith(safeImportPath);
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  });

  it("includes importer and resolved path context when a bundled sidecar is missing", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-entry-contract-"));
    tempDirs.push(tempRoot);

    const pluginRoot = path.join(tempRoot, "dist", "extensions", "telegram");
    fs.mkdirSync(pluginRoot, { recursive: true });

    const importerPath = path.join(pluginRoot, "index.js");
    fs.writeFileSync(importerPath, "export default {};\n", "utf8");

    const { loadBundledEntryExportSync } = await import("./channel-entry-contract.js");

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

  it("loads packaged telegram setup sidecars from dist-facing api modules", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-entry-contract-"));
    tempDirs.push(tempRoot);

    const pluginRoot = path.join(tempRoot, "dist", "extensions", "telegram");
    fs.mkdirSync(pluginRoot, { recursive: true });

    const importerPath = path.join(pluginRoot, "setup-entry.js");
    const setupApiPath = path.join(pluginRoot, "setup-plugin-api.js");
    const secretsApiPath = path.join(pluginRoot, "secret-contract-api.js");

    fs.writeFileSync(importerPath, "export default {};\n", "utf8");
    fs.writeFileSync(
      setupApiPath,
      'export const telegramSetupPlugin = { id: "telegram" };\n',
      "utf8",
    );
    fs.writeFileSync(
      secretsApiPath,
      [
        "export const collectRuntimeConfigAssignments = () => [];",
        "export const secretTargetRegistryEntries = [];",
        'export const channelSecrets = { TELEGRAM_TOKEN: { env: "TELEGRAM_TOKEN" } };',
        "",
      ].join("\n"),
      "utf8",
    );

    const { loadBundledEntryExportSync } = await import("./channel-entry-contract.js");

    expect(
      loadBundledEntryExportSync<{ id: string }>(pathToFileURL(importerPath).href, {
        specifier: "./setup-plugin-api.js",
        exportName: "telegramSetupPlugin",
      }),
    ).toEqual({ id: "telegram" });

    expect(
      loadBundledEntryExportSync<Record<string, unknown>>(pathToFileURL(importerPath).href, {
        specifier: "./secret-contract-api.js",
        exportName: "channelSecrets",
      }),
    ).toEqual({
      TELEGRAM_TOKEN: {
        env: "TELEGRAM_TOKEN",
      },
    });
  });

  it("can disable source-tree fallback for dist bundled entry checks", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-entry-contract-"));
    tempDirs.push(tempRoot);

    fs.writeFileSync(path.join(tempRoot, "package.json"), '{"name":"openclaw"}\n', "utf8");
    const pluginRoot = path.join(tempRoot, "dist", "extensions", "telegram");
    const sourceRoot = path.join(tempRoot, "extensions", "telegram", "src");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.mkdirSync(sourceRoot, { recursive: true });

    const importerPath = path.join(pluginRoot, "index.js");
    fs.writeFileSync(importerPath, "export default {};\n", "utf8");
    fs.writeFileSync(
      path.join(sourceRoot, "secret-contract.ts"),
      "export const sentinel = 42;\n",
      "utf8",
    );

    const { loadBundledEntryExportSync } = await import("./channel-entry-contract.js");

    expect(
      loadBundledEntryExportSync<number>(pathToFileURL(importerPath).href, {
        specifier: "./src/secret-contract.js",
        exportName: "sentinel",
      }),
    ).toBe(42);

    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK", "1");

    expect(() =>
      loadBundledEntryExportSync<number>(pathToFileURL(importerPath).href, {
        specifier: "./src/secret-contract.js",
        exportName: "sentinel",
      }),
    ).toThrow(`resolved "${path.join(pluginRoot, "src", "secret-contract.js")}"`);
  });
});
