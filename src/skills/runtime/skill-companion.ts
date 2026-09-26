import fs from "node:fs/promises";
import path from "node:path";
import { FsSafeError, root as createFsSafeRoot } from "../../infra/fs-safe.js";
import type { SkillSourceRootIdentity } from "../loading/skill-contract.js";

export const SKILL_COMPANION_MAX_BYTES = 256_000;

/** Final source-host owner for one selected skill companion read. */
export async function readSkillCompanionAtSource(params: {
  skillFilePath: string;
  relativePath: string;
  sourceRootIdentity: SkillSourceRootIdentity;
  signal?: AbortSignal;
}): Promise<string> {
  params.signal?.throwIfAborted();
  if (path.basename(params.skillFilePath).toLowerCase() !== "skill.md") {
    throw new Error("Skill companion root must be selected by its SKILL.md path");
  }
  const root = await createFsSafeRoot(path.dirname(path.resolve(params.skillFilePath)));
  params.signal?.throwIfAborted();
  let expectedDev: bigint;
  let expectedIno: bigint;
  try {
    if (
      !/^[1-9]\d{0,19}$/u.test(params.sourceRootIdentity.dev) ||
      !/^[1-9]\d{0,19}$/u.test(params.sourceRootIdentity.ino)
    ) {
      throw new Error("identity must contain nonzero unsigned 64-bit decimal values");
    }
    expectedDev = BigInt(params.sourceRootIdentity.dev);
    expectedIno = BigInt(params.sourceRootIdentity.ino);
  } catch (error) {
    throw new FsSafeError("path-mismatch", "selected skill root identity is invalid", {
      cause: error,
    });
  }
  const observed = await fs.stat(root.rootReal, { bigint: true });
  if (
    expectedDev === 0n ||
    expectedIno === 0n ||
    root.rootReal !== params.sourceRootIdentity.realPath ||
    observed.dev !== expectedDev ||
    observed.ino !== expectedIno
  ) {
    throw new FsSafeError("path-mismatch", "selected skill root identity changed");
  }
  params.signal?.throwIfAborted();
  const result = await root.read(params.relativePath, {
    hardlinks: "reject",
    maxBytes: SKILL_COMPANION_MAX_BYTES,
    symlinks: "reject",
  });
  params.signal?.throwIfAborted();
  return result.buffer.toString("utf8");
}
