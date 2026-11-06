import path from "node:path";

type NodeFilesystemPolicy = {
  readonly trustedWritableAncestors?: readonly string[];
};

let nodeFilesystemPolicy: NodeFilesystemPolicy | undefined;

/** Only node admission activates operator policy; generic temp-root imports stay strict. */
export function captureNodeTrustedWritableAncestors(): readonly string[] | undefined {
  if (nodeFilesystemPolicy) {
    return nodeFilesystemPolicy.trustedWritableAncestors;
  }
  const raw = process.env.OPENCLAW_NODE_TRUSTED_WRITABLE_ANCESTORS;
  delete process.env.OPENCLAW_NODE_TRUSTED_WRITABLE_ANCESTORS;
  let trustedWritableAncestors: readonly string[] | undefined;
  if (raw !== undefined) {
    const invalidPolicy =
      "OPENCLAW_NODE_TRUSTED_WRITABLE_ANCESTORS must be a JSON array of canonical absolute paths";
    try {
      const value: unknown = JSON.parse(raw);
      const fs = process.getBuiltinModule("fs");
      if (
        !Array.isArray(value) ||
        !value.every(
          (entry) =>
            typeof entry === "string" &&
            path.isAbsolute(entry) &&
            path.normalize(entry) === entry &&
            fs.realpathSync.native(entry) === entry,
        )
      ) {
        throw new Error(invalidPolicy);
      }
      trustedWritableAncestors = Object.freeze(value);
    } catch {
      throw new Error(invalidPolicy);
    }
  }
  nodeFilesystemPolicy = Object.freeze({ trustedWritableAncestors });
  return trustedWritableAncestors;
}

/** Shared consumers cannot activate or change the node's captured policy. */
export function getNodeTrustedWritableAncestors(): readonly string[] | undefined {
  return nodeFilesystemPolicy?.trustedWritableAncestors;
}
