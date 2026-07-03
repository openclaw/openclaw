// Check Openclaw Package Tarball tests cover check openclaw package tarball script behavior.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCAL_BUILD_METADATA_DIST_PATHS } from "../../scripts/lib/local-build-metadata-paths.mjs";

const CHECK_SCRIPT = "scripts/check-openclaw-package-tarball.mjs";
const FLAT_PLUGIN_SDK_DECLARATION = "dist/plugin-sdk/provider-entry.d.ts";
const DEEP_PLUGIN_SDK_DECLARATION = "dist/plugin-sdk/src/plugin-sdk/provider-entry.d.ts";

function withTarball(
  inventory: string[],
  files: Record<string, string>,
  testBody: (tarball: string) => void,
  version = "0.0.0",
  options: {
    includeContentInventory?: boolean;
    includeControlUi?: boolean;
    includeShrinkwrap?: boolean;
    contentInventoryModes?: Record<string, number>;
    extraRootFiles?: Record<string, string>;
    extraPackEntries?: string[];
    packageFifos?: string[];
    packageModes?: Record<string, number>;
    packageSymlinks?: Record<string, string>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-package-tarball-test-"));
  try {
    const packageRoot = join(root, "package");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "openclaw", version }));
    if (options.includeShrinkwrap !== false) {
      writeFileSync(
        join(packageRoot, "npm-shrinkwrap.json"),
        JSON.stringify({
          name: "openclaw",
          version,
          lockfileVersion: 3,
          packages: {
            "": {
              name: "openclaw",
              version,
            },
          },
        }),
      );
    }
    writeFileSync(
      join(packageRoot, "dist", "postinstall-inventory.json"),
      JSON.stringify(
        options.includeControlUi === false
          ? inventory
          : [
              ...new Set([
                ...inventory,
                "dist/control-ui/index.html",
                "dist/control-ui/assets/app.js",
              ]),
            ],
      ),
    );
    const tarFiles =
      options.includeControlUi === false
        ? files
        : {
            "dist/control-ui/index.html": "<!doctype html><openclaw-app></openclaw-app>",
            "dist/control-ui/assets/app.js": "console.log('ok');\n",
            ...files,
          };
    for (const [relativePath, body] of Object.entries(tarFiles)) {
      const filePath = join(packageRoot, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, body);
    }
    for (const [relativePath, target] of Object.entries(options.packageSymlinks ?? {})) {
      const filePath = join(packageRoot, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      rmSync(filePath, { recursive: true, force: true });
      symlinkSync(target, filePath);
    }
    for (const [relativePath, mode] of Object.entries(options.packageModes ?? {})) {
      chmodSync(join(packageRoot, relativePath), mode);
    }
    for (const [relativePath, body] of Object.entries(options.extraRootFiles ?? {})) {
      const filePath = join(root, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, body);
    }
    if (options.includeContentInventory !== false) {
      const contentInventory = [
        ...new Set([
          ...inventory,
          ...(options.includeControlUi === false
            ? []
            : ["dist/control-ui/index.html", "dist/control-ui/assets/app.js"]),
        ]),
      ]
        .filter((relativePath) => Object.hasOwn(tarFiles, relativePath))
        .map((relativePath) => {
          const body = tarFiles[relativePath] ?? "";
          return {
            path: relativePath,
            sha256: createHash("sha256").update(body).digest("hex"),
            mode: options.contentInventoryModes?.[relativePath] ?? 0o644,
            size: Buffer.byteLength(body),
          };
        });
      writeFileSync(
        join(packageRoot, "dist", "postinstall-content-inventory.json"),
        JSON.stringify(contentInventory),
      );
    }
    for (const relativePath of options.packageFifos ?? []) {
      const filePath = join(packageRoot, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      rmSync(filePath, { force: true });
      const mkfifo = spawnSync("mkfifo", [filePath], { encoding: "utf8" });
      expect(mkfifo.status, mkfifo.stderr).toBe(0);
    }

    const tarball = join(root, "openclaw.tgz");
    const pack = spawnSync(
      "tar",
      [
        "-czf",
        tarball,
        "-C",
        root,
        "package",
        ...Object.keys(options.extraRootFiles ?? {}),
        ...(options.extraPackEntries ?? []),
      ],
      {
        encoding: "utf8",
      },
    );
    expect(pack.status, pack.stderr).toBe(0);
    testBody(tarball);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("check-openclaw-package-tarball", () => {
  it("prints help before touching tarball state", () => {
    const result = spawnSync("node", [CHECK_SCRIPT, "--help"], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Usage: node scripts/check-openclaw-package-tarball.mjs <openclaw.tgz>",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects option-like and extra arguments before tar inspection", () => {
    const unknown = spawnSync("node", [CHECK_SCRIPT, "--tag"], { encoding: "utf8" });

    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("Unknown OpenClaw package tarball check option: --tag");
    expect(unknown.stderr).not.toContain("OpenClaw package tarball does not exist");

    const extra = spawnSync("node", [CHECK_SCRIPT, "openclaw.tgz", "extra"], {
      encoding: "utf8",
    });

    expect(extra.status).not.toBe(0);
    expect(extra.stderr).toContain("Unexpected OpenClaw package tarball check argument: extra");
    expect(extra.stderr).not.toContain("OpenClaw package tarball does not exist");
  });

  it.runIf(process.platform !== "win32")(
    "removes the extract dir when tar extraction fails",
    () => {
      const root = mkdtempSync(join(tmpdir(), "openclaw-package-tarball-extract-fail-"));
      try {
        const fakeBin = join(root, "bin");
        mkdirSync(fakeBin);
        const extractDirFile = join(root, "extract-dir.txt");
        const fakeTar = join(fakeBin, "tar");
        writeFileSync(
          fakeTar,
          [
            "#!/usr/bin/env node",
            "const fs = require('node:fs');",
            "const args = process.argv.slice(2);",
            "if (args[0] === '-tf') { console.log('package/package.json'); process.exit(0); }",
            "const outputDir = args[args.indexOf('-C') + 1];",
            "fs.writeFileSync(process.env.OPENCLAW_TEST_EXTRACT_DIR_FILE, outputDir);",
            "console.error('extract denied');",
            "process.exit(7);",
          ].join("\n"),
        );
        chmodSync(fakeTar, 0o755);
        const tarball = join(root, "openclaw.tgz");
        writeFileSync(tarball, "not used by fake tar");

        const result = spawnSync("node", [CHECK_SCRIPT, tarball], {
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_TEST_EXTRACT_DIR_FILE: extractDirFile,
            PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ""}`,
          },
        });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("extract denied");
        expect(existsSync(readFileSync(extractDirFile, "utf8"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("allows legacy private QA inventory entries omitted from shipped tarballs through 2026.4.25", () => {
    withTarball(
      ["dist/index.js", "dist/extensions/qa-channel/runtime-api.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("legacy inventory references omitted private QA");
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.25-beta.10",
    );
  });

  it("rejects legacy private QA inventory omissions for newer packages", () => {
    withTarball(
      ["dist/index.js", "dist/extensions/qa-channel/runtime-api.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "inventory references missing tar entry dist/extensions/qa-channel/runtime-api.js",
        );
        expect(result.stderr).not.toContain("legacy inventory references omitted private QA");
      },
      "2026.4.26",
    );
  });

  it("still rejects non-legacy missing inventory entries", () => {
    withTarball(
      ["dist/index.js", "dist/cli.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("inventory references missing tar entry dist/cli.js");
      },
    );
  });

  it("rejects packaged source maps omitted from the dist inventories", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        "dist/index.js.map": '{"version":3,"sources":["index.ts"]}\n',
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("inventory omits packaged dist file dist/index.js.map");
        expect(result.stderr).toContain(
          "content inventory omits packaged dist file dist/index.js.map",
        );
      },
    );
  });

  it.each(["2026.6.7", "2026.6.8-beta.3", "2026.6.10-alpha.3"])(
    "rejects missing content inventory for package %s",
    (version) => {
      withTarball(
        ["dist/index.js"],
        { "dist/index.js": "export {};\n" },
        (tarball) => {
          const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("missing dist/postinstall-content-inventory.json");
        },
        version,
        { includeContentInventory: false },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked package metadata used for legacy compatibility",
    () => {
      const legacyVersion = "2026.5.21";
      withTarball(
        ["dist/index.js"],
        { "dist/index.js": "export {};\n" },
        (tarball) => {
          const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("unsafe package metadata tar entry package.json");
          expect(result.stderr).toContain("unsafe package metadata tar entry npm-shrinkwrap.json");
          expect(result.stderr).toContain("missing dist/postinstall-content-inventory.json");
        },
        "2026.6.7",
        {
          extraRootFiles: {
            "legacy-package.json": JSON.stringify({ name: "openclaw", version: legacyVersion }),
            "legacy-shrinkwrap.json": JSON.stringify({
              name: "openclaw",
              version: legacyVersion,
              lockfileVersion: 3,
              packages: { "": { name: "openclaw", version: legacyVersion } },
            }),
          },
          includeContentInventory: false,
          packageSymlinks: {
            "package.json": "../legacy-package.json",
            "npm-shrinkwrap.json": "../legacy-shrinkwrap.json",
          },
        },
      );
    },
  );

  it("rejects content inventory outside the package root", () => {
    const body = "export {};\n";
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": body },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("missing dist/postinstall-content-inventory.json");
      },
      "2026.6.7",
      {
        includeContentInventory: false,
        extraRootFiles: {
          "dist/postinstall-content-inventory.json": JSON.stringify([
            {
              path: "dist/index.js",
              sha256: createHash("sha256").update(body).digest("hex"),
              mode: 0o644,
              size: Buffer.byteLength(body),
            },
          ]),
        },
      },
    );
  });

  it("rejects package inventory entries that only exist outside the package root", () => {
    const body = "export {};\n";
    withTarball(
      ["dist/index.js"],
      {
        "dist/postinstall-content-inventory.json": JSON.stringify([
          {
            path: "dist/index.js",
            sha256: createHash("sha256").update(body).digest("hex"),
            mode: 0o644,
            size: Buffer.byteLength(body),
          },
        ]),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("inventory references missing tar entry dist/index.js");
        expect(result.stderr).toContain(
          "content inventory references missing tar entry dist/index.js",
        );
      },
      "2026.6.7",
      {
        includeContentInventory: false,
        extraRootFiles: { "dist/index.js": body },
      },
    );
  });

  it.each([
    "2026.6.5",
    "2026.6.5-beta.6",
    "2026.6.6",
    "2026.6.6-beta.2",
    "2026.6.7-alpha.6",
    "2026.6.7-beta.1",
    "2026.6.8-alpha.2",
    "2026.6.8-beta.1",
    "2026.6.8-beta.2",
    "2026.6.8",
    "2026.6.9-alpha.4",
    "2026.6.9-alpha.5",
    "2026.6.10-alpha.2",
    "2026.6.15-alpha.1",
  ])("allows published package %s without content inventory", (version) => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain(
          "legacy package omits dist/postinstall-content-inventory.json",
        );
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      version,
      { includeContentInventory: false },
    );
  });

  it("rejects stale content inventory hashes", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        "dist/postinstall-content-inventory.json": JSON.stringify([
          { path: "dist/index.js", sha256: "0".repeat(64), mode: 0o644, size: 11 },
        ]),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("content inventory hash mismatch for dist/index.js");
      },
      "2026.5.21",
      { includeContentInventory: false },
    );
  });

  it.runIf(process.platform !== "win32")("rejects content inventory executable mismatches", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "content inventory executable mode mismatch for dist/index.js",
        );
      },
      "2026.5.21",
      { packageModes: { "dist/index.js": 0o755 } },
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects distinct content inventory executable masks",
    () => {
      const body = "export {};\n";
      withTarball(
        ["dist/index.js"],
        { "dist/index.js": body },
        (tarball) => {
          const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(
            "content inventory executable mode mismatch for dist/index.js",
          );
        },
        "2026.5.21",
        {
          contentInventoryModes: { "dist/index.js": 0o755 },
          packageModes: { "dist/index.js": 0o700 },
        },
      );
    },
  );

  it
    .runIf(process.platform !== "win32")
    .each(["dist/postinstall-inventory.json", "dist/postinstall-content-inventory.json"])(
    "rejects FIFO package metadata at %s without blocking",
    (relativePath) => {
      withTarball(
        [],
        {},
        (tarball) => {
          const result = spawnSync("node", [CHECK_SCRIPT, tarball], {
            encoding: "utf8",
            timeout: 5_000,
          });

          expect(result.error).toBeUndefined();
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(`unsafe package metadata tar entry ${relativePath}`);
        },
        "2026.5.21",
        { packageFifos: [relativePath] },
      );
    },
  );

  it("rejects duplicate normalized content inventory paths", () => {
    const body = "export {};\n";
    const entry = {
      path: "dist/index.js",
      sha256: createHash("sha256").update(body).digest("hex"),
      mode: 0o644,
      size: Buffer.byteLength(body),
    };
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": body,
        "dist/postinstall-content-inventory.json": JSON.stringify([
          entry,
          { ...entry, path: "dist\\index.js" },
        ]),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "duplicate normalized content inventory entry: dist/index.js",
        );
      },
      "2026.5.21",
      { includeContentInventory: false },
    );
  });

  it("rejects packaged dist files omitted from both inventories", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        "dist/extra.js": "export const extra = true;\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("inventory omits packaged dist file dist/extra.js");
        expect(result.stderr).toContain("content inventory omits packaged dist file dist/extra.js");
      },
      "2026.5.21",
    );
  });

  it("rejects content inventory entries omitted from the path inventory", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": "export {};\n",
        "dist/extra.js": "export {};\n",
        "dist/postinstall-content-inventory.json": JSON.stringify([
          {
            path: "dist/index.js",
            sha256: createHash("sha256").update("export {};\n").digest("hex"),
            mode: 0o644,
            size: "export {};\n".length,
          },
          {
            path: "dist/extra.js",
            sha256: createHash("sha256").update("export {};\n").digest("hex"),
            mode: 0o644,
            size: "export {};\n".length,
          },
        ]),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "content inventory references non-inventoried dist file dist/extra.js",
        );
      },
      "2026.5.21",
      { includeContentInventory: false },
    );
  });

  it("rejects unsafe content inventory paths before reading them", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-package-content-inventory-unsafe-"));
    try {
      const outsidePath = join(root, "outside.js");
      const outsideBody = "export const outside = true;\n";
      writeFileSync(outsidePath, outsideBody);
      withTarball(
        ["dist/index.js"],
        {
          "dist/index.js": "export {};\n",
          "dist/postinstall-content-inventory.json": JSON.stringify([
            {
              path: outsidePath,
              sha256: createHash("sha256").update(outsideBody).digest("hex"),
              mode: 0o644,
              size: Buffer.byteLength(outsideBody),
            },
          ]),
        },
        (tarball) => {
          const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain(`unsafe content inventory entry ${outsidePath}`);
        },
        "2026.5.21",
        { includeContentInventory: false },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate normalized tar entries before content hashes can shadow package files", () => {
    const installedBody = "export const installed = true;\n";
    const shadowBody = "export const shadow = true;\n";
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": installedBody,
        "dist/postinstall-content-inventory.json": JSON.stringify([
          {
            path: "dist/index.js",
            sha256: createHash("sha256").update(shadowBody).digest("hex"),
            mode: 0o644,
            size: Buffer.byteLength(shadowBody),
          },
        ]),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("duplicate normalized tar entry: dist/index.js");
      },
      "2026.5.21",
      {
        extraRootFiles: { "dist/index.js": shadowBody },
        includeContentInventory: false,
      },
    );
  });

  it("rejects dot-segment tar entries that normalize over packaged files", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("unsafe tar entry: ./dist/index.js");
        expect(result.stderr).toContain("duplicate normalized tar entry: dist/index.js");
      },
      "2026.5.21",
      { extraPackEntries: ["package/./dist/index.js"] },
    );
  });

  it.runIf(process.platform !== "win32")("rejects symlinked content inventory tar entries", () => {
    const targetBody = "export const target = true;\n";
    withTarball(
      ["dist/index.js"],
      {
        "dist/target.js": targetBody,
        "dist/postinstall-content-inventory.json": JSON.stringify([
          {
            path: "dist/index.js",
            sha256: createHash("sha256").update(targetBody).digest("hex"),
            mode: 0o644,
            size: Buffer.byteLength(targetBody),
          },
        ]),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("unsafe extracted dist entry: package/dist/index.js");
      },
      "2026.5.21",
      {
        includeContentInventory: false,
        packageSymlinks: { "dist/index.js": "target.js" },
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "rejects content inventory reads through symlinked dist parents",
    () => {
      const root = mkdtempSync(join(tmpdir(), "openclaw-package-dist-symlink-test-"));
      try {
        const targetBody = "export const target = true;\n";
        const packageRoot = join(root, "package");
        const rootDist = join(root, "dist");
        mkdirSync(packageRoot, { recursive: true });
        mkdirSync(join(rootDist, "control-ui", "assets"), { recursive: true });
        writeFileSync(
          join(packageRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2026.5.21" }),
        );
        writeFileSync(
          join(packageRoot, "npm-shrinkwrap.json"),
          JSON.stringify({
            name: "openclaw",
            version: "2026.5.21",
            lockfileVersion: 3,
            packages: { "": { name: "openclaw", version: "2026.5.21" } },
          }),
        );
        symlinkSync("../dist", join(packageRoot, "dist"));
        writeFileSync(join(rootDist, "index.js"), targetBody);
        writeFileSync(
          join(rootDist, "control-ui", "index.html"),
          "<!doctype html><openclaw-app></openclaw-app>",
        );
        writeFileSync(join(rootDist, "control-ui", "assets", "app.js"), "console.log('ok');\n");
        writeFileSync(
          join(rootDist, "postinstall-inventory.json"),
          JSON.stringify(["dist/index.js"]),
        );
        writeFileSync(
          join(rootDist, "postinstall-content-inventory.json"),
          JSON.stringify([
            {
              path: "dist/index.js",
              sha256: createHash("sha256").update(targetBody).digest("hex"),
              mode: 0o644,
              size: Buffer.byteLength(targetBody),
            },
          ]),
        );
        const tarball = join(root, "openclaw.tgz");
        const pack = spawnSync("tar", ["-czf", tarball, "-C", root, "package", "dist"], {
          encoding: "utf8",
        });
        expect(pack.status, pack.stderr).toBe(0);

        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("unsafe extracted dist root: package/dist");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked dist parents before parsing empty content inventories",
    () => {
      const root = mkdtempSync(join(tmpdir(), "openclaw-package-empty-dist-symlink-test-"));
      try {
        const packageRoot = join(root, "package");
        const rootDist = join(root, "dist");
        mkdirSync(packageRoot, { recursive: true });
        mkdirSync(join(rootDist, "control-ui", "assets"), { recursive: true });
        writeFileSync(
          join(packageRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version: "2026.5.21" }),
        );
        writeFileSync(
          join(packageRoot, "npm-shrinkwrap.json"),
          JSON.stringify({
            name: "openclaw",
            version: "2026.5.21",
            lockfileVersion: 3,
            packages: { "": { name: "openclaw", version: "2026.5.21" } },
          }),
        );
        symlinkSync("../dist", join(packageRoot, "dist"));
        writeFileSync(
          join(rootDist, "control-ui", "index.html"),
          "<!doctype html><openclaw-app></openclaw-app>",
        );
        writeFileSync(join(rootDist, "control-ui", "assets", "app.js"), "console.log('ok');\n");
        writeFileSync(join(rootDist, "postinstall-inventory.json"), JSON.stringify([]));
        writeFileSync(join(rootDist, "postinstall-content-inventory.json"), JSON.stringify([]));
        const tarball = join(root, "openclaw.tgz");
        const pack = spawnSync("tar", ["-czf", tarball, "-C", root, "package", "dist"], {
          encoding: "utf8",
        });
        expect(pack.status, pack.stderr).toBe(0);

        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("unsafe extracted dist root: package/dist");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects symlinked package ancestors before traversing dist",
    () => {
      const root = mkdtempSync(join(tmpdir(), "openclaw-package-ancestor-symlink-test-"));
      try {
        const outsideRoot = join(root, "outside-package");
        mkdirSync(join(outsideRoot, "dist"), { recursive: true });
        symlinkSync("missing-target.js", join(outsideRoot, "dist", "sensitive-external-name.js"));
        symlinkSync(outsideRoot, join(root, "package"));
        const tarball = join(root, "openclaw.tgz");
        const pack = spawnSync("tar", ["-czf", tarball, "-C", root, "package"], {
          encoding: "utf8",
        });
        expect(pack.status, pack.stderr).toBe(0);

        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("unsafe extracted dist root: package/dist");
        expect(result.stderr).not.toContain("sensitive-external-name.js");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")("rejects broken symlinked dist parents", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-package-broken-dist-symlink-test-"));
    try {
      const packageRoot = join(root, "package");
      const rootDist = join(root, "dist");
      mkdirSync(packageRoot, { recursive: true });
      mkdirSync(join(rootDist, "control-ui", "assets"), { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: "2026.5.21" }),
      );
      writeFileSync(
        join(packageRoot, "npm-shrinkwrap.json"),
        JSON.stringify({
          name: "openclaw",
          version: "2026.5.21",
          lockfileVersion: 3,
          packages: { "": { name: "openclaw", version: "2026.5.21" } },
        }),
      );
      symlinkSync("../missing-dist", join(packageRoot, "dist"));
      writeFileSync(
        join(rootDist, "control-ui", "index.html"),
        "<!doctype html><openclaw-app></openclaw-app>",
      );
      writeFileSync(join(rootDist, "control-ui", "assets", "app.js"), "console.log('ok');\n");
      writeFileSync(join(rootDist, "postinstall-inventory.json"), JSON.stringify([]));
      writeFileSync(join(rootDist, "postinstall-content-inventory.json"), JSON.stringify([]));
      const tarball = join(root, "openclaw.tgz");
      const pack = spawnSync("tar", ["-czf", tarball, "-C", root, "package", "dist"], {
        encoding: "utf8",
      });
      expect(pack.status, pack.stderr).toBe(0);

      const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unsafe extracted dist root: package/dist");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "rejects uninventoried symlinked dist children before content inventory reads",
    () => {
      withTarball(
        [],
        {},
        (tarball) => {
          const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("unsafe extracted dist entry: package/dist/evil.js");
        },
        "2026.5.21",
        { packageSymlinks: { "dist/evil.js": "target.js" } },
      );
    },
  );

  it("rejects stale deep plugin SDK declaration inventory entries", () => {
    withTarball(
      [FLAT_PLUGIN_SDK_DECLARATION, DEEP_PLUGIN_SDK_DECLARATION],
      { [FLAT_PLUGIN_SDK_DECLARATION]: "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          `inventory references missing tar entry ${DEEP_PLUGIN_SDK_DECLARATION}`,
        );
      },
    );
  });

  it("accepts flat plugin SDK declaration inventory without the old deep tree", () => {
    withTarball(
      [FLAT_PLUGIN_SDK_DECLARATION],
      { [FLAT_PLUGIN_SDK_DECLARATION]: "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
    );
  });

  it("rejects dist files that import missing relative chunks", () => {
    withTarball(
      ["dist/cli/run-main.js"],
      { "dist/cli/run-main.js": 'await import("../memory-state-old.js");\n' },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "dist/cli/run-main.js imports missing dist/memory-state-old.js",
        );
      },
      "2026.4.27",
    );
  });

  it("accepts dist files whose relative chunks are present", () => {
    withTarball(
      ["dist/cli/run-main.js", "dist/memory-state-current.js"],
      {
        "dist/cli/run-main.js": 'await import("../memory-state-current.js");\n',
        "dist/memory-state-current.js": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.27",
    );
  });

  it("rejects imported dist chunks omitted from the postinstall inventory", () => {
    withTarball(
      ["dist/cli/run-main.js"],
      {
        "dist/cli/run-main.js": 'await import("../memory-state-current.js");\n',
        "dist/memory-state-current.js": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "inventory omits imported dist file dist/memory-state-current.js",
        );
      },
      "2026.4.27",
    );
  });

  it("rejects CommonJS require chunks omitted from the postinstall inventory", () => {
    withTarball(
      ["dist/index.cjs"],
      {
        "dist/index.cjs": 'module.exports = require("./chunk.cjs");\n',
        "dist/chunk.cjs": "module.exports = {};\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("inventory omits imported dist file dist/chunk.cjs");
      },
      "2026.4.27",
    );
  });

  it("rejects dist files with missing import.meta.url URL dependencies", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": 'const worker = new URL("./worker.js", import.meta.url);\n' },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("dist/index.js imports missing dist/worker.js");
      },
      "2026.4.27",
    );
  });

  it("rejects formatted import.meta.url URL dependencies", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": [
          "const worker = new URL(",
          '  "./worker.js",',
          "  import.meta.url,",
          ");",
          "",
        ].join("\n"),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("dist/index.js imports missing dist/worker.js");
      },
      "2026.4.27",
    );
  });

  it("rejects import.meta.url URL dependencies omitted from the postinstall inventory", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js": 'const worker = new URL("./worker.js", import.meta.url);\n',
        "dist/worker.js": "export {};\n",
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("inventory omits imported dist file dist/worker.js");
      },
      "2026.4.27",
    );
  });

  it("allows import.meta.url package-root probes", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": 'const root = new URL("../..", import.meta.url);\n' },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.27",
    );
  });

  it("allows import.meta.url source helper probes", () => {
    withTarball(
      ["dist/index.js"],
      {
        "dist/index.js":
          'const shim = new URL("./capability-runtime-vitest-shims/config-runtime.ts", import.meta.url);\n',
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.27",
    );
  });

  it("rejects missing Control UI assets", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("missing required tar entry dist/control-ui/index.html");
        expect(result.stderr).toContain(
          "missing required tar entries under dist/control-ui/assets/",
        );
      },
      "2026.4.27",
      { includeControlUi: false },
    );
  });

  it("allows legacy package tarballs without shrinkwrap", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain("legacy package omits npm-shrinkwrap.json");
      },
      "2026.5.20",
      { includeShrinkwrap: false },
    );
  });

  it("rejects new package tarballs without shrinkwrap", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("missing required tar entry npm-shrinkwrap.json");
      },
      "2026.5.21",
      { includeShrinkwrap: false },
    );
  });

  it("rejects package-lock.json in package tarballs", () => {
    withTarball(
      ["dist/index.js"],
      { "dist/index.js": "export {};\n", "package-lock.json": "{}\n" },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "package tarball must ship npm-shrinkwrap.json, not package-lock.json",
        );
      },
      "2026.4.27",
    );
  });

  it("rejects local build metadata entries in package tarballs", () => {
    withTarball(
      ["dist/index.js", ...LOCAL_BUILD_METADATA_DIST_PATHS],
      {
        "dist/index.js": "export {};\n",
        ...Object.fromEntries(LOCAL_BUILD_METADATA_DIST_PATHS.map((entry) => [entry, "{}\n"])),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          "forbidden local build metadata tar entry dist/.buildstamp",
        );
        expect(result.stderr).toContain(
          "forbidden local build metadata tar entry dist/.runtime-postbuildstamp",
        );
      },
      "2026.4.27",
    );
  });

  it("allows local build metadata in already published legacy packages through 2026.4.26", () => {
    withTarball(
      ["dist/index.js", ...LOCAL_BUILD_METADATA_DIST_PATHS],
      {
        "dist/index.js": "export {};\n",
        ...Object.fromEntries(LOCAL_BUILD_METADATA_DIST_PATHS.map((entry) => [entry, "{}\n"])),
      },
      (tarball) => {
        const result = spawnSync("node", [CHECK_SCRIPT, tarball], { encoding: "utf8" });

        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toContain(
          "legacy package includes local build metadata tar entry dist/.buildstamp",
        );
        expect(result.stderr).toContain(
          "legacy package includes local build metadata tar entry dist/.runtime-postbuildstamp",
        );
        expect(result.stdout).toContain("OpenClaw package tarball integrity passed.");
      },
      "2026.4.26",
    );
  });
});
