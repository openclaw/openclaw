import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function installProcSafe(root: string, source: string, addon: boolean): void {
  const modules = path.join(root, "node_modules", "@openclaw");
  writeFile(path.join(modules, "proc-safe", "package.json"), '{"type":"module"}');
  writeFile(
    path.join(modules, "proc-safe", "dist", "identity.js"),
    `export const source = "${source}";`,
  );
  if (addon) {
    installAddon(root);
  }
}

function installAddon(root: string): void {
  const addon = path.join(root, "node_modules", "@openclaw", `proc-safe-freebsd-${process.arch}`);
  writeFile(path.join(addon, "package.json"), '{"main":"proc-safe-native.node"}');
  writeFile(path.join(addon, "proc-safe-native.node"), "");
}

async function loadFrom(roots: readonly string[]): Promise<unknown> {
  vi.resetModules();
  const loader = await import("./package-update-activation-native-loader.js");
  loader.selectPackageActivationNativeRoots(roots);
  return loader.loadFreeBsdProcessIdentityNative();
}

it("loads proc-safe only from a recorded tree that also carries its addon", async () => {
  const host = fs.realpathSync(dirs.make("openclaw-package-native-"));
  // The host's own node_modules sits above every recorded tree.
  installAddon(host);
  const live = path.join(host, "live");
  const previous = path.join(host, "anchor", "previous");
  installProcSafe(live, "live", false);
  installProcSafe(previous, "previous", true);

  await expect(
    loadFrom([live, previous, path.join(host, "anchor", "candidate")]),
  ).resolves.toMatchObject({
    source: "previous",
  });
  await expect(loadFrom([live])).rejects.toThrow(
    "Package recovery found no recorded FreeBSD native runtime",
  );
});
