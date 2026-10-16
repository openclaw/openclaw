import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../state/openclaw-schema-versions.js";
import type { CommandRunner } from "./update-runner-types.js";

type GitTargetSchemaMetadata =
  | {
      status: "ok";
      version?: string;
      schemaVersions?: OpenClawSchemaVersions;
      databaseEngines?: unknown;
      postgresFamilies?: unknown;
    }
  | { status: "unreadable"; reason: string };

export async function readGitTargetSchemaVersions(params: {
  runCommand: CommandRunner;
  root: string;
  revision: string;
  timeoutMs: number;
}): Promise<GitTargetSchemaMetadata> {
  let result: Awaited<ReturnType<CommandRunner>>;
  try {
    result = await params.runCommand(
      ["git", "-C", params.root, "show", `${params.revision}:package.json`],
      { cwd: params.root, timeoutMs: params.timeoutMs },
    );
  } catch (error) {
    return { status: "unreadable", reason: String(error) };
  }
  if (result.code !== 0) {
    return {
      status: "unreadable",
      reason: `git show ${params.revision}:package.json exited ${result.code}`,
    };
  }
  try {
    const manifest: unknown = JSON.parse(result.stdout);
    const schemaVersions = parsePackageOpenClawSchemaVersions(manifest);
    const version = normalizeNullableString(asNullableRecord(manifest)?.version);
    const databaseEngines = asNullableRecord(asNullableRecord(manifest)?.openclaw)?.databaseEngines;
    const postgresFamilies = asNullableRecord(
      asNullableRecord(manifest)?.openclaw,
    )?.postgresFamilies;
    return {
      status: "ok",
      ...(version ? { version } : {}),
      ...(schemaVersions ? { schemaVersions } : {}),
      ...(databaseEngines === undefined ? {} : { databaseEngines }),
      ...(postgresFamilies === undefined ? {} : { postgresFamilies }),
    };
  } catch (error) {
    return { status: "unreadable", reason: `target package.json unparseable: ${String(error)}` };
  }
}
