import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  isLegacyPluginDependencyInstallStagePath as isInstallStage,
  LOCAL_BUILD_METADATA_DIST_PATHS,
  writePackageDistInventory,
  writePackageDistInventoryForPublish,
} from "../../scripts/lib/package-dist-inventory.ts";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  collectPackageDistContentInventory,
  collectPackageDistInventory,
  readPackageDistInventoryIfPresent,
} from "./package-dist-inventory.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let packageRoot: string;
const at = (relative: string) => path.join(packageRoot, relative);
beforeEach(() => {
  packageRoot = dirs.make("openclaw-dist-inventory-");
});
afterEach(() => __setFsSafeTestHooksForTest());
async function writeFiles(paths: readonly string[], content = "export {};\n") {
  for (const relativePath of paths) {
    const filePath = at(relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }
}

const writeJson = (file: string, data: unknown) => writeFiles([file], JSON.stringify(data));
const missing = (file: string) =>
  expect(fs.access(at(file))).rejects.toMatchObject({ code: "ENOENT" });
const collect = () => collectPackageDistInventory(packageRoot);
const publish = () => writePackageDistInventoryForPublish(packageRoot);
const inventory = () => writePackageDistInventory(packageRoot);
const content = (files?: string[]) => collectPackageDistContentInventory(packageRoot, files);
const expectInventory = (result: Promise<string[]>, ...files: string[]) =>
  expect(result).resolves.toEqual([...files, "dist/postinstall-content-inventory.json"]);
const currentInventory = ["dist/current.js", "dist/postinstall-content-inventory.json"] as const;

it("retains binary digests, byte counts, modes, and allowed package hardlinks", async () => {
  const distDir = at("dist");
  const binaryPath = path.join(distDir, "binary.js");
  const binary = Buffer.alloc(128 * 1024 + 7, 0xa5);
  binary[0] = 0;
  binary[binary.length - 1] = 0xff;
  await fs.mkdir(distDir);
  await fs.writeFile(binaryPath, binary);
  await fs.chmod(binaryPath, 0o751);
  await fs.link(binaryPath, path.join(distDir, "linked.js"));
  await fs.writeFile(path.join(distDir, "empty.js"), "", { mode: 0o600 });
  const binaryEntry = {
    sha256: createHash("sha256").update(binary).digest("hex"),
    size: binary.byteLength,
    mode: process.platform === "win32" ? (await fs.stat(binaryPath)).mode & 0o777 : 0o751,
  };
  await expect(content()).resolves.toEqual([
    { path: "dist/binary.js", ...binaryEntry },
    {
      path: "dist/empty.js",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      size: 0,
      mode:
        process.platform === "win32"
          ? (await fs.stat(path.join(distDir, "empty.js"))).mode & 0o777
          : 0o600,
    },
    { path: "dist/linked.js", ...binaryEntry },
  ]);
});

it.each(["content", "inventory", "publication"] as const)(
  "rejects symlinked entries at the %s boundary",
  async (boundary) => {
    const publishing = boundary === "publication";
    const entry = publishing ? "dist/extensions/browser" : "dist/entry.js";
    const target = at("outside");
    await fs.mkdir(path.dirname(at(entry)), { recursive: true });
    if (publishing) {
      await fs.mkdir(path.join(target, ".openclaw-install-stage"), { recursive: true });
    } else {
      await fs.writeFile(target, "outside");
    }
    await fs.symlink(
      publishing ? target : "../outside",
      at(entry),
      publishing && process.platform === "win32" ? "junction" : publishing ? "dir" : "file",
    );
    if (boundary === "content") {
      await expect(content([entry])).rejects.toMatchObject({ code: "symlink" });
    } else {
      await expect(publishing ? publish() : collect()).rejects.toThrow(
        `Unsafe package dist path: ${entry}`,
      );
    }
    if (publishing) {
      await missing(PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
    }
  },
);

it("hashes the complete file when it outgrows the admitted small-file buffer", async () => {
  const filePath = at("dist/growing.js");
  const grown = Buffer.alloc(128 * 1024 + 7, 0x71);
  await writeFiles(["dist/growing.js"], "small");
  let replaced = false;
  __setFsSafeTestHooksForTest({
    beforeRootReadFinalFence: async (openedPath) => {
      if (!replaced && path.basename(openedPath) === "growing.js") {
        replaced = true;
        await fs.writeFile(filePath, grown);
      }
    },
  });
  await expect(content()).resolves.toEqual([
    expect.objectContaining({
      path: "dist/growing.js",
      sha256: createHash("sha256").update(grown).digest("hex"),
      size: grown.byteLength,
    }),
  ]);
  expect(replaced).toBe(true);
});

it("tracks missing and stale files while keeping lifecycle state outside the inventory", async () => {
  const currentFile = at(currentInventory[0]);
  await writeFiles([currentInventory[0]]);

  await expect(readPackageDistInventoryIfPresent(packageRoot)).resolves.toBeNull();
  await expect(publish()).resolves.toEqual(currentInventory);
  await expect(readPackageDistInventoryIfPresent(packageRoot)).resolves.toStrictEqual(
    currentInventory,
  );
  await expect(collect()).resolves.toEqual(currentInventory);
  await expect(fs.readFile(at(PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH), "utf8")).resolves.toBe(
    "pending\n",
  );
  await fs.rm(currentFile);
  await writeFiles(["dist/stale.js"]);

  await expect(collect()).resolves.toEqual([
    "dist/postinstall-content-inventory.json",
    "dist/stale.js",
  ]);
});

it("omits build and dependency artifacts while retaining packaged runtime files", async () => {
  await writeFiles([
    "dist/extensions/qa-channel/runtime-api.js",
    "dist/extensions/qa-lab/runtime-api.js",
    "dist/extensions/qa-channel/cli.js",
    "dist/extensions/qa-lab/cli.js",
    "dist/plugin-sdk/qa-lab.js",
    "dist/plugin-sdk/qa-channel.js",
    "dist/plugin-sdk/qa-channel-protocol.js",
    "dist/plugin-sdk/extensions/qa-lab/cli.d.ts",
    "dist/plugin-sdk/src/plugin-sdk/provider-entry.d.ts",
    "dist/plugin-sdk/provider-entry.d.ts",
    "dist/qa-runtime-B9LDtssJ.js",
    "dist/extensions/demo/runtime-api.js",
    "dist/extensions/node_modules/openclaw/package.json",
    "dist/extensions/demo/node_modules/left-pad/package.json",
  ]);
  await writeFiles(LOCAL_BUILD_METADATA_DIST_PATHS, "{}\n");
  await writeFiles(["dist/feature.runtime.js.map"], "{}");
  await expect(inventory()).resolves.toStrictEqual([
    "dist/extensions/demo/runtime-api.js",
    "dist/plugin-sdk/provider-entry.d.ts",
    "dist/postinstall-content-inventory.json",
  ]);
});

it.each([
  { exclusion: "!dist/OpenClaw.app/**", app: "dist/OpenClaw.app" },
  { exclusion: "!dist/**/*.app/**", app: "dist/.stage/OpenClaw.app" },
  { exclusion: "!dist/OpenClaw.app", app: "dist/OpenClaw.app" },
  { exclusion: "!dist/**/*.app", app: "dist/.stage/OpenClaw.app" },
])(
  "honors package files exclusions ($exclusion) when writing the dist inventory",
  async ({ exclusion, app }) => {
    const omittedAppBundle = at(app);
    await fs.mkdir(omittedAppBundle, { recursive: true });
    await writeJson("package.json", {
      files: [
        "dist/",
        exclusion,
        "!dist/plugin-sdk/plugin-test-runtime.js",
        "!dist/plugin-sdk/plugin-test-runtime.d.ts",
        "!dist/plugin-sdk/src/test-utils/**",
        "!dist/plugin-sdk/qa-channel.*",
        "!dist/qa-runtime-*.js",
        "!dist/**/*.map",
      ],
    });
    await writeFiles([
      "dist/plugin-sdk/runtime.js",
      "dist/plugin-sdk/plugin-test-runtime.js",
      "dist/plugin-sdk/plugin-test-runtime.d.ts",
      "dist/plugin-sdk/src/test-utils/helpers.d.ts",
      "dist/plugin-sdk/qa-channel.js",
      "dist/qa-runtime-AbC123.js",
    ]);
    await writeFiles(["dist/runtime.js.map", "dist/plugin-sdk/runtime.js.map"], "{}");
    await fs.symlink(packageRoot, path.join(omittedAppBundle, "Autoupdate"));

    await expectInventory(inventory(), "dist/plugin-sdk/runtime.js");
  },
);

it("omits interrupted Control UI build siblings through the root package files list", async () => {
  const { files } = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8"));
  await writeJson("package.json", { files });
  await writeFiles([
    "dist/control-ui/index.html",
    "dist/control-ui.build-123-AbCdEf/assets/index.js",
    "dist/control-ui.build-123-AbCdEf.retired/index.html",
  ]);

  await expectInventory(inventory(), "dist/control-ui/index.html");
});

it.each([
  { entry: "index.js", excluded: true },
  { entry: "", excluded: true },
  { entry: "index.js", excluded: false },
])("honors plugin entry $entry exclusions (excluded=$excluded)", async ({ entry, excluded }) => {
  await writeFiles([
    path.join("dist/extensions/published-chat", entry),
    "dist/extensions/bundled-chat/index.js",
  ]);
  if (excluded) {
    await writeJson("package.json", {
      files: ["dist/", "!dist/extensions/published-chat/**"],
    });
  }
  await expect(inventory()).resolves.toEqual([
    "dist/extensions/bundled-chat/index.js",
    ...(excluded ? [] : ["dist/extensions/published-chat/index.js"]),
    "dist/postinstall-content-inventory.json",
  ]);
});

it("matches install-stage paths case-insensitively across path segments", () => {
  const paths = [
    "dist/extensions/brave/.openclaw-install-stage/node_modules/typebox/package.json",
    "dist/Extensions/browser/.OPENCLAW-INSTALL-STAGE-AbC123/node_modules/playwright-core/package.json",
    "Dist/Extensions/browser/.OpenClaw-Install-Stage/package.json",
    "dist/extensions/browser/.openclaw-runtime-deps-copy-AbC123/package.json",
    "dist/extensions/.openclaw-install-stage",
  ];
  expect(paths.map(isInstallStage)).toEqual([true, true, true, false, false]);
});

it.each(["directory", "file", "symlink", "mixed-case"] as const)(
  "rejects install-stage %s debris before changing published inventory artifacts",
  async (kind) => {
    const stagePath = path.join(
      packageRoot,
      kind === "mixed-case"
        ? "Dist/Extensions/browser/.OPENCLAW-INSTALL-STAGE-AbC123"
        : "dist/extensions/browser/.openclaw-install-stage-AbC123",
    );
    await fs.mkdir(path.dirname(stagePath), { recursive: true });
    if (kind === "directory" || kind === "mixed-case") {
      await fs.mkdir(stagePath);
      await fs.writeFile(path.join(stagePath, "package.json"), "{}");
    } else if (kind === "file") {
      await fs.writeFile(stagePath, "debris");
    } else {
      await fs.symlink(packageRoot, stagePath, process.platform === "win32" ? "junction" : "dir");
    }
    const artifacts = [
      "dist/postinstall-inventory.json",
      "dist/postinstall-content-inventory.json",
      PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
    ];
    await writeFiles(artifacts, "previous publication\n");
    await expect(publish()).rejects.toThrow(/unexpected legacy plugin dependency staging debris/u);
    for (const artifact of artifacts) {
      await expect(fs.readFile(at(artifact), "utf8")).resolves.toBe("previous publication\n");
    }
  },
);

it.each(["ENOENT", "EACCES"])("handles %s scans before publication", async (code) => {
  const failure = Object.assign(new Error("inventory scan failed"), { code });
  const scan = vi.spyOn(fs, "readdir").mockRejectedValueOnce(failure);
  try {
    if (code === "ENOENT") {
      await expectInventory(publish());
    } else {
      await expect(publish()).rejects.toBe(failure);
      await missing("dist");
      await missing(PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH);
    }
  } finally {
    scan.mockRestore();
  }
});

it("only treats plugin-root install stages as dependency staging debris", async () => {
  const files = [
    "dist/extensions/.openclaw-install-stage/index.js",
    "dist/extensions/browser/assets/.openclaw-install-stage/index.js",
  ];
  await writeFiles(files);
  await expect(inventory()).resolves.toEqual([...files, "dist/postinstall-content-inventory.json"]);
});
