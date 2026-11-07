import {
  parseStrictInteger,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";

export type LaunchctlPrintInfo = {
  state?: string;
  pid?: number;
  lastExitStatus?: number;
  lastExitReason?: string;
};

/** Parse only the selected job's root fields; nested jobs and environments are not its identity. */
export function parseLaunchctlJob(output: string, serviceTarget: string) {
  if (!output.startsWith(`${serviceTarget} = {\n`)) {
    throw new Error(`Cannot parse launchd job ${serviceTarget}`);
  }
  const fields = new Map<string, string>();
  for (const [, name, value] of output.matchAll(/^\t([^\t\n=]+) = (.+)$/gm)) {
    if (fields.has(name!)) {
      throw new Error(`Duplicate launchd job field ${name}`);
    }
    fields.set(name!, value!);
  }
  const block = (name: string) =>
    output.match(new RegExp(`^\\t${name} = \\{\\n([\\s\\S]*?)^\\t\\}`, "m"))?.[1];
  const runtime: LaunchctlPrintInfo = {};
  const state = fields.get("state")?.trim();
  if (state) {
    runtime.state = state;
  }
  const pid = parseStrictPositiveInteger(fields.get("pid"));
  if (pid !== undefined) {
    runtime.pid = pid;
  }
  const status = parseStrictInteger(fields.get("last exit status"));
  if (status !== undefined) {
    runtime.lastExitStatus = status;
  }
  const exitReason = fields.get("last exit reason")?.trim();
  if (exitReason) {
    runtime.lastExitReason = exitReason;
  }
  return {
    fields,
    runtime,
    arguments: block("arguments")
      ?.split("\n")
      .filter((line) => line.startsWith("\t\t"))
      .map((line) => line.slice(2)),
    environment: block("environment") ?? "",
    environmentBlocks: [
      ...output.matchAll(/^\t(?:inherited |default )?environment = \{\n([\s\S]*?)^\t\}/gm),
    ]
      .map((match) => match[1] ?? "")
      .join("\n"),
  };
}
