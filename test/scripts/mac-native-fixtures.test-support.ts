import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import type { MacScriptFixture } from "./mac-script-fixture.test-support.js";

const systemPath = "/usr/bin:/bin:/usr/sbin:/sbin";

export async function runMacFixtureTool(
  command: string,
  args: string[],
  root: string,
  mac: MacScriptFixture,
) {
  const result = await mac.run(command, args, {
    encoding: "utf8",
    cwd: root,
    env: { HOME: root, TMPDIR: root, PATH: systemPath },
  });
  expect(result, `${command}: ${result.stderr}`).toMatchObject({ error: undefined, status: 0 });
  return result.stdout.trim();
}

const prepareMacObjects = nativeFixturePreparation(compileMacObjects);
const prepareMacNativeFixtures = nativeFixturePreparation(compileMacNativeFixtures);

export async function macObjectFixture(
  root: string,
  arch: "arm64" | "x86_64",
  mac: MacScriptFixture,
) {
  return (await prepareMacObjects(root, mac))[arch];
}

export async function macFatContainerFixture(
  root: string,
  slices: readonly Buffer[],
  fat64: boolean,
  mac: MacScriptFixture,
) {
  const inputs = [];
  for (const [index, bytes] of slices.entries()) {
    const file = path.join(root, `fat-container-input-${index}`);
    await writeFile(file, bytes);
    inputs.push(file);
  }
  const output = path.join(root, "fat-container");
  await runMacFixtureTool(
    "/usr/bin/lipo",
    ["-create", ...(fat64 ? ["-fat64"] : []), ...inputs, "-output", output],
    root,
    mac,
  );
  return readFile(output);
}

export async function singleSliceMacFat64(
  root: string,
  arch: "arm64" | "x86_64",
  mac: MacScriptFixture,
) {
  const bytes = await macFatContainerFixture(
    root,
    [(await compiledMacNativeFixtures(root, mac))[arch]],
    true,
    mac,
  );
  const output = path.join(root, "fat-container");
  expect(await runMacFixtureTool("/usr/bin/lipo", ["-archs", output], root, mac)).toBe(arch);
  expect(bytes.subarray(0, 4).toString("hex")).toBe("cafebabf");
  return bytes;
}

export async function compiledMacNativeFixtures(root: string, mac: MacScriptFixture) {
  return prepareMacNativeFixtures(root, mac);
}

function nativeFixturePreparation<T>(compile: (root: string, mac: MacScriptFixture) => Promise<T>) {
  let fixtures: Promise<T> | undefined;
  return (root: string, mac: MacScriptFixture) => {
    if (fixtures) {
      return fixtures;
    }
    // The first case owns preparation; only complete in-memory bytes are shared.
    // Failed borrowers reject together; a later lifetime can prepare independently.
    const preparation = mac.lifetime.run(() => compile(root, mac));
    fixtures = preparation;
    void preparation.catch(() => {
      if (fixtures === preparation) {
        fixtures = undefined;
      }
    });
    return preparation;
  };
}

async function compileMacObjects(root: string, mac: MacScriptFixture) {
  const source = path.join(root, "inert-object.c");
  await writeFile(source, "int main(void) { return 0; }\n");
  for (const arch of ["arm64", "x86_64"] as const) {
    await runMacFixtureTool(
      "/usr/bin/xcrun",
      ["clang", "-arch", arch, "-c", source, "-o", path.join(root, `${arch}.o`)],
      root,
      mac,
    );
  }
  return {
    arm64: await readFile(path.join(root, "arm64.o")),
    x86_64: await readFile(path.join(root, "x86_64.o")),
  };
}

async function compileMacNativeFixtures(root: string, mac: MacScriptFixture) {
  // Full-image and object borrowers must share the first preparation failure.
  const objects = await prepareMacObjects(root, mac);
  const tool = (command: string, args: string[]) => runMacFixtureTool(command, args, root, mac);
  const at = (name: string) => path.join(root, name);
  const source = path.join(root, "inert.c");
  await writeFile(source, "int main(void) { return 0; }\n");
  for (const [arch, prefix] of [
    ["arm64", "arm"],
    ["x86_64", "intel"],
  ] as const) {
    for (const dynamic of [false, true]) {
      const output = at(dynamic ? `${prefix}-library` : arch);
      await tool("/usr/bin/xcrun", [
        "clang",
        "-arch",
        arch,
        "-mmacosx-version-min=14.0",
        "-Wl,-no_adhoc_codesign",
        ...(dynamic ? ["-dynamiclib"] : []),
        source,
        "-o",
        output,
      ]);
      expect(await tool("/usr/bin/lipo", ["-archs", output])).toBe(arch);
    }
    await writeFile(at(`${arch}.o`), objects[arch]);
    await tool("/usr/bin/ar", ["rcs", at(`${prefix}.a`), at(`${arch}.o`)]);
    expect(await tool("/usr/bin/lipo", ["-archs", at(`${prefix}.a`)])).toBe(arch);
  }
  for (const [arm, intel, output, extra] of [
    ["arm64", "x86_64", "universal", []],
    ["arm-library", "intel-library", "universal-library", []],
    ["arm64", "x86_64", "fat64", ["-fat64"]],
    ["arm.a", "intel.a", "universal.a", []],
  ] as const) {
    await tool("/usr/bin/lipo", ["-create", ...extra, at(arm), at(intel), "-output", at(output)]);
  }
  for (const [target, output, format] of [
    ["x86_64-unknown-linux-gnu", "elf", "ELF"],
    ["x86_64-pc-windows-msvc", "windows.obj", "COFF"],
  ] as const) {
    await tool("/usr/bin/xcrun", ["clang", "-target", target, "-c", source, "-o", at(output)]);
    expect(await tool("/usr/bin/file", ["-b", at(output)])).toContain(format);
  }
  // Minimal inert PE32+ image: DOS header, NT/optional headers, one .text section.
  const pe = Buffer.alloc(1024);
  pe.write("MZ");
  pe.writeUInt32LE(128, 60);
  pe.write("PE\0\0", 128);
  pe.writeUInt16LE(0x8664, 132);
  pe.writeUInt16LE(1, 134);
  pe.writeUInt16LE(240, 148);
  pe.writeUInt16LE(0x22, 150);
  pe.writeUInt16LE(0x20b, 152);
  pe.writeUInt32LE(4096, 168);
  pe.writeBigUInt64LE(0x140000000n, 176);
  pe.writeUInt32LE(4096, 184);
  pe.writeUInt32LE(512, 188);
  pe.writeUInt32LE(8192, 208);
  pe.writeUInt32LE(512, 212);
  pe.writeUInt16LE(3, 220);
  pe.write(".text", 392);
  pe.writeUInt32LE(1, 400);
  pe.writeUInt32LE(4096, 404);
  pe.writeUInt32LE(512, 408);
  pe.writeUInt32LE(512, 412);
  pe.writeUInt32LE(0x60000020, 428);
  pe[512] = 0xc3;
  const peFile = path.join(root, "windows.exe");
  await writeFile(peFile, pe);
  expect(await tool("/usr/bin/file", ["-b", peFile])).toContain("PE32+");
  return {
    arm64: await readFile(at("arm64")),
    x86_64: await readFile(at("x86_64")),
    universal: await readFile(at("universal")),
    fat64: await readFile(at("fat64")),
    universalArchive: await readFile(at("universal.a")),
    coff: await readFile(at("windows.obj")),
    pe,
    armLibrary: await readFile(at("arm-library")),
    intelLibrary: await readFile(at("intel-library")),
    universalLibrary: await readFile(at("universal-library")),
    elf: await readFile(at("elf")),
    armArchive: await readFile(at("arm.a")),
    intelArchive: await readFile(at("intel.a")),
  };
}
