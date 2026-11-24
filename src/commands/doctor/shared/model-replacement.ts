import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { CyberAccessProgram } from "../../../../packages/gateway-protocol/src/schema/sessions-row.js";

/** Invocation-only choices, never inferred from retiring alias names. */
export type DoctorModelReplacement = {
  from: string;
  to: string;
  accessProgram: CyberAccessProgram;
};

export function parseDoctorModelReplacements(values: readonly string[]): DoctorModelReplacement[] {
  const choices = values.map((value): DoctorModelReplacement => {
    let row: Record<string, unknown> | undefined;
    try {
      row = asOptionalRecord(JSON.parse(value));
    } catch {
      throw new Error("--replace-model requires a JSON object.");
    }
    const from = typeof row?.from === "string" ? row.from.trim() : "";
    const to = typeof row?.to === "string" ? row.to.trim() : "";
    const accessProgram = row?.accessProgram;
    if (
      !/^openai\/gpt-daybreak-(blue|red)-latest$/.test(from) ||
      !/^openai\/[^/@\s]+$/.test(to) ||
      /^openai\/gpt-daybreak-(blue|red)-latest$/.test(to) ||
      (accessProgram !== "standard" &&
        accessProgram !== "daybreak_blue" &&
        accessProgram !== "daybreak_red") ||
      Object.keys(row ?? {}).some((key) => !["from", "to", "accessProgram"].includes(key))
    ) {
      throw new Error(
        '--replace-model requires {"from":"openai/gpt-daybreak-blue-latest" (or red),"to":"openai/<specific-model>","accessProgram":"standard" (or daybreak_blue/daybreak_red)}, without account suffixes.',
      );
    }
    return { from, to, accessProgram };
  });
  const sources = new Set<string>();
  const programs = new Map<string, CyberAccessProgram>();
  for (const choice of choices) {
    if (sources.has(choice.from)) {
      throw new Error("Duplicate --replace-model source: " + choice.from);
    }
    if (programs.has(choice.to) && programs.get(choice.to) !== choice.accessProgram) {
      throw new Error("Conflicting Access programs for --replace-model target: " + choice.to);
    }
    sources.add(choice.from);
    programs.set(choice.to, choice.accessProgram);
  }
  return choices;
}
