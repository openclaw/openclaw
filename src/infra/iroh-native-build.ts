import { statSync } from "node:fs";
import path from "node:path";
import { listDirectoryTreeStrictSync } from "./directory-walk.ts";

export const irohNativeBuildInputs = [
  "Cargo.toml",
  "Cargo.lock",
  "build.rs",
  "package.json",
  "rust-toolchain.toml",
  "src",
];

/** Match napi's local build artifact for the host, including Linux libc. */
export function irohNativeBinaryName(): string {
  const { platform, arch } = process;
  let suffix = "";
  if (platform === "linux") {
    const report = process.report?.getReport?.();
    const header = report && "header" in report ? report.header : null;
    const glibc = header && typeof header === "object" && "glibcVersionRuntime" in header;
    suffix = glibc ? "-gnu" : "-musl";
  } else if (platform === "win32") {
    suffix = "-msvc";
  }
  return ["iroh-node.", platform, "-", arch, suffix, ".node"].join("");
}

/** A local binary is current only when it is newer than every native build input. */
export function isIrohBuildCurrent(crateDir: string, binaryName = irohNativeBinaryName()): boolean {
  const binary = statSync(path.join(crateDir, binaryName), { throwIfNoEntry: false });
  if (!binary?.isFile() || binary.size === 0) {
    return false;
  }
  const isOlder = (input: string) =>
    (statSync(path.join(crateDir, input), { throwIfNoEntry: false })?.mtimeMs ?? Infinity) <
    binary.mtimeMs;
  // Include directories so deleting a source file also invalidates the build.
  return (
    irohNativeBuildInputs.every(isOlder) &&
    listDirectoryTreeStrictSync(path.join(crateDir, "src")).every(({ relativePath }) =>
      isOlder(path.join("src", relativePath)),
    )
  );
}
