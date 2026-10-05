import fsSync from "node:fs";
import path from "node:path";
import { packageActivationRuntimeIdentity } from "./package-update-activation-paths.js";
import type { ImmutableInstallDescriptor } from "./update-immutable-install-schema.js";
const SHA = /^[a-f0-9]{40}$/u;

export function directoryIdentity(file: string): string {
  const stat = fsSync.lstatSync(file);
  if (!stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    throw new Error(`Immutable installation directory must be root-owned and protected: ${file}`);
  }
  return `${stat.dev}:${stat.ino}`;
}

export function readImmutableLayout(root: string) {
  if (fsSync.realpathSync(root) !== root) {
    throw new Error("Immutable installation must have a canonical physical root.");
  }
  const rootIdentity = directoryIdentity(root);
  const releases = path.join(root, "releases");
  const releasesIdentity = directoryIdentity(releases);
  const pointer = path.join(root, "current");
  const stat = fsSync.lstatSync(pointer);
  const target = stat.isSymbolicLink() ? fsSync.readlinkSync(pointer) : "";
  const generationPath = path.resolve(root, target);
  const sha = path.basename(generationPath);
  if (
    !stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    !SHA.test(sha) ||
    path.dirname(generationPath) !== releases
  ) {
    throw new Error(
      "Immutable current must select a root-owned direct releases/<40-hex SHA> generation.",
    );
  }
  const identity = directoryIdentity(generationPath);
  if (
    fsSync.realpathSync(pointer) !== generationPath ||
    rootIdentity.split(":")[0] !== releasesIdentity.split(":")[0] ||
    identity.split(":")[0] !== releasesIdentity.split(":")[0]
  ) {
    throw new Error("Immutable release layout must be contained on one filesystem.");
  }
  return {
    rootIdentity,
    releasesIdentity,
    current: { sha, path: generationPath, identity, pointerIdentity: `${stat.dev}:${stat.ino}` },
  };
}

export function assertImmutableDescriptorCurrent(descriptor: ImmutableInstallDescriptor): void {
  const layout = readImmutableLayout(descriptor.root);
  if (
    layout.rootIdentity !== descriptor.rootIdentity ||
    layout.releasesIdentity !== descriptor.releasesIdentity ||
    layout.current.sha !== descriptor.current.sha ||
    layout.current.path !== descriptor.current.path ||
    layout.current.identity !== descriptor.current.identity ||
    layout.current.pointerIdentity !== descriptor.current.pointerIdentity ||
    packageActivationRuntimeIdentity(descriptor.runtime.path) !== descriptor.runtime.identity
  ) {
    throw new Error("Immutable installation changed since adoption; current was not modified.");
  }
}
