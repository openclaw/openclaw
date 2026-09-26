import path from "node:path";
import { z } from "zod";

export const MAX_SOURCE_ATTESTATION_BYTES = 32 * 1024 * 1024;
const count = 100_000;
const unsigned = z
  .string()
  .max(20)
  .regex(/^(0|[1-9][0-9]*)$/u);
const timestamp = z
  .string()
  .max(21)
  .regex(/^-?(0|[1-9][0-9]*)$/u);
const identity = z
  .string()
  .max(41)
  .regex(/^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => !value.includes("\0") && path.isAbsolute(value) && path.resolve(value) === value,
  );
const metadata = {
  identity,
  mode: z.number().int().min(0).max(0o7777),
  uid: unsigned,
  gid: unsigned,
  nlink: unsigned.refine((value) => value !== "0"),
  mtimeNs: timestamp,
  ctimeNs: timestamp,
  birthtimeNs: timestamp,
};
const name = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value !== "." && value !== ".." && !value.includes("\0") && !value.includes(path.sep),
  );
const image = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("missing") }),
  z.strictObject({
    kind: z.literal("file"),
    ...metadata,
    sha256: digest,
    size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    kind: z.literal("directory"),
    ...metadata,
    children: z
      .array(name)
      .max(count)
      .refine((names) => new Set(names).size === names.length),
  }),
  z.strictObject({
    kind: z.literal("symlink"),
    ...metadata,
    target: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes("\0")),
  }),
]);
export const updateRecoverySourceRefSchema = z.strictObject({ path: absolute, sha256: digest });
const updateRecoverySourceAttestationSchema = z
  .strictObject({
    protocol: z.literal("update-recovery-source-v1"),
    runId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u),
    operationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u),
    candidateManifestSha256: digest,
    resources: z
      .array(
        z.strictObject({
          sourcePath: absolute,
          ancestor: z.strictObject({ path: absolute, identity }),
          image,
          sidecars: z
            .array(z.strictObject({ suffix: z.enum(["-wal", "-shm", "-journal"]), image }))
            .max(3),
        }),
      )
      .min(1)
      .max(count),
  })
  .superRefine((value, context) => {
    const paths = new Set<string>();
    let members = 0;
    for (const resource of value.resources) {
      const relative = path.relative(resource.ancestor.path, resource.sourcePath);
      if (
        !relative ||
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`)
      ) {
        context.addIssue({
          code: "custom",
          message: "Source ancestor does not contain the resource.",
        });
      }
      for (const file of [
        resource.sourcePath,
        ...resource.sidecars.map((s) => resource.sourcePath + s.suffix),
      ]) {
        if (paths.has(file)) {
          context.addIssue({ code: "custom", message: "Duplicate source or sidecar path." });
        }
        paths.add(file);
      }
      members += resource.image.kind === "directory" ? resource.image.children.length : 0;
      if (
        resource.sidecars.some(
          (s) =>
            s.image.kind !== "missing" &&
            (s.image.kind !== "file" || resource.image.kind !== "file"),
        )
      ) {
        context.addIssue({ code: "custom", message: "Invalid source sidecar kind." });
      }
    }
    if (members > count) {
      context.addIssue({
        code: "custom",
        message: "Source directory membership exceeds its bound.",
      });
    }
  });
export type UpdateRecoverySourceAttestation = z.infer<typeof updateRecoverySourceAttestationSchema>;
export type UpdateRecoverySourceRef = z.infer<typeof updateRecoverySourceRefSchema>;

/** This is the exact wire encoding. Canonical readback also rejects duplicate JSON keys. */
export function serializeUpdateRecoverySourceAttestation(input: UpdateRecoverySourceAttestation) {
  const raw = JSON.stringify(updateRecoverySourceAttestationSchema.parse(input)) + "\n";
  if (Buffer.byteLength(raw) > MAX_SOURCE_ATTESTATION_BYTES) {
    throw new Error("Update recovery source attestation exceeds its bound.");
  }
  return raw;
}
export function parseUpdateRecoverySourceAttestation(raw: Buffer): UpdateRecoverySourceAttestation {
  if (raw.length > MAX_SOURCE_ATTESTATION_BYTES) {
    throw new Error("Update recovery source attestation exceeds its bound.");
  }
  const value = updateRecoverySourceAttestationSchema.parse(JSON.parse(raw.toString("utf8")));
  if (!raw.equals(Buffer.from(serializeUpdateRecoverySourceAttestation(value)))) {
    throw new Error("Update recovery source attestation is not the canonical encoding.");
  }
  const freeze = (object: object) => {
    for (const item of Object.values(object)) {
      if (item && typeof item === "object") {
        freeze(item);
      }
    }
    Object.freeze(object);
  };
  freeze(value);
  return value;
}
