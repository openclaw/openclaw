import { createHash } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** An image-ready reserve carries runtime capacity, never repository contents or authority. */
export type ImageReserveProject = { kind: "image"; key: string };

export function imageReserveProject(namespace: string): ImageReserveProject {
  return {
    kind: "image",
    key: createHash("sha256").update(`image-reserve\0${namespace}`).digest("hex"),
  };
}

export function readImageReserveProject(value: unknown): ImageReserveProject | undefined {
  if (!isRecord(value) || value.kind !== "image") {
    return undefined;
  }
  if (typeof value.key !== "string" || !/^[a-f0-9]{64}$/u.test(value.key)) {
    throw new Error("Worker image reserve has an invalid identity");
  }
  return { kind: "image", key: value.key };
}
