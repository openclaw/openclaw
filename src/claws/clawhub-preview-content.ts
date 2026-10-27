import type { ClawHubFetchOptions } from "../infra/clawhub-client.js";
import { fetchClawHubSkillCard } from "../infra/clawhub-skills.js";
import { root as fsSafeRoot } from "../infra/fs-safe.js";
import { parseRequestedClawHubSkillRef } from "../skills/lifecycle/clawhub-store.js";
import { ClawHubSourceError, type ResolvedClawHubSource } from "./clawhub-source-artifact.js";
import { digestClawBytes } from "./digest.js";
import { MAX_MANAGED_FILE_BYTES } from "./source-limits.js";

export type ClawHubClawCatalogPreview = {
  kind: "instruction" | "skill";
  name: string;
  content: string;
};

export async function readClawHubCatalogPreview(input: {
  params: ClawHubFetchOptions & { packageName: string; version: string };
  requested: Pick<ClawHubClawCatalogPreview, "kind" | "name"> | undefined;
  instructions: Array<{ name: string; source: string }>;
  skills: Array<{ name: string; version: string }>;
  verified: ResolvedClawHubSource;
  rootDir: string;
}): Promise<ClawHubClawCatalogPreview | undefined> {
  const { requested, instructions, skills, verified, rootDir, params } = input;
  if (requested?.kind === "instruction") {
    const instruction = instructions.find((file) => file.name === requested.name);
    if (!instruction) {
      return undefined;
    }
    const source =
      verified.packageBootstrap?.sourcePath === instruction.source
        ? verified.packageBootstrap
        : verified.snapshot.workspaceSources.find((file) => file.sourcePath === instruction.source);
    if (instruction.source !== "CLAW.md#body" && !source) {
      throw new ClawHubSourceError(
        "clawhub_preview_unavailable",
        "This workspace file is not available in the verified Claw release.",
      );
    }
    let content: string | undefined;
    if (instruction.source === "CLAW.md#body") {
      content = verified.clawMarkdownBody?.toString("utf8");
    } else {
      const root = await fsSafeRoot(rootDir);
      const read = await root.read(instruction.source, {
        hardlinks: "reject",
        maxBytes: MAX_MANAGED_FILE_BYTES,
        symlinks: "reject",
      });
      if (
        read.buffer.byteLength !== source!.byteLength ||
        digestClawBytes(read.buffer) !== source!.digest
      ) {
        throw new ClawHubSourceError(
          "clawhub_preview_unavailable",
          "This workspace file changed during preview.",
        );
      }
      content = read.buffer.toString("utf8");
    }
    return content === undefined
      ? undefined
      : { kind: "instruction", name: instruction.name, content };
  }
  if (requested?.kind === "skill") {
    const skill = skills.find((item) => item.name === requested.name);
    if (!skill) {
      return undefined;
    }
    const ref = parseRequestedClawHubSkillRef(skill.name);
    const content = await fetchClawHubSkillCard({
      ...params,
      slug: ref.slug,
      ...(ref.ownerHandle ? { ownerHandle: ref.ownerHandle } : {}),
      version: skill.version,
    }).catch(() => {
      throw new ClawHubSourceError(
        "clawhub_preview_unavailable",
        "This skill's content is unavailable from the configured ClawHub.",
      );
    });
    return { kind: "skill", name: skill.name, content };
  }
  return undefined;
}
