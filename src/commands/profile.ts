import {
  createProfileArchive,
  formatProfileExportSummary,
  formatProfileImportSummary,
  importProfileArchive,
  type ProfileExportOptions,
  type ProfileExportResult,
  type ProfileImportOptions,
  type ProfileImportResult,
} from "../infra/profile-portability.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";

export type {
  ProfileExportOptions,
  ProfileExportResult,
  ProfileImportOptions,
  ProfileImportResult,
};

export async function profileExportCommand(
  runtime: RuntimeEnv,
  opts: ProfileExportOptions = {},
): Promise<ProfileExportResult> {
  const result = await createProfileArchive(opts);
  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatProfileExportSummary(result).join("\n"));
  }
  return result;
}

export async function profileImportCommand(
  runtime: RuntimeEnv,
  opts: ProfileImportOptions,
): Promise<ProfileImportResult> {
  const result = await importProfileArchive(opts);
  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatProfileImportSummary(result).join("\n"));
  }
  return result;
}
