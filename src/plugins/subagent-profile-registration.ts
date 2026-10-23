import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  describeRootFileOpenFailure,
  readFileDescriptorBoundedSync,
} from "../infra/boundary-file-read.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import { isPluginJsonValue } from "./host-hook-json.js";
import { openPluginRootFileSync } from "./path-safety.js";
import type { PluginRegistryState } from "./registry-state.js";
import type { PluginRecord } from "./registry-types.js";
import { validateJsonSchemaValue } from "./schema-validator.js";
import type { PluginSubagentProfile, RegisteredSubagentProfile } from "./subagent-profile.types.js";

const MAX_INSTRUCTIONS_BYTES = 256 * 1024;

/** Registration pins bytes once; spawns never reopen a mutable package path. */
export function registerSubagentProfile(
  state: PluginRegistryState,
  record: PluginRecord,
  input: PluginSubagentProfile,
): void {
  const fail = (message: string): never => {
    throw new Error(`Subagent profile: ${message}`);
  };
  if (
    !isRecord(input) ||
    Object.keys(input).some(
      (key) => !["id", "description", "instructionsFile", "outputSchema", "tools"].includes(key),
    )
  ) {
    fail("only id, description, instructionsFile, outputSchema and tools are supported");
  }
  const { id, description, instructionsFile, outputSchema, tools } = input;
  if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(id)) {
    fail("id must be a plugin-local lowercase identifier");
  }
  if (!record.contracts?.subagentProfiles?.includes(id)) {
    fail(`declare contracts.subagentProfiles for ${id}`);
  }
  if (typeof description !== "string" || !description.trim()) {
    fail("description is required");
  }
  if (
    state.registry.subagentProfiles.some(
      (profile) => profile.pluginId === record.id && profile.id === id,
    )
  ) {
    fail(`already registered: ${id}`);
  }
  if (
    !record.rootDir ||
    typeof instructionsFile !== "string" ||
    !instructionsFile.trim() ||
    path.isAbsolute(instructionsFile) ||
    path.win32.isAbsolute(instructionsFile) ||
    instructionsFile.split(/[\\/]/u).includes("..")
  ) {
    fail("instructionsFile must stay inside the plugin package");
  }
  if (
    tools !== undefined &&
    (!isRecord(tools) ||
      Object.keys(tools).some((key) => key !== "deny") ||
      !Array.isArray(tools.deny) ||
      tools.deny.some((tool) => typeof tool !== "string" || !tool.trim()))
  ) {
    fail("tools accepts only a deny array of nonempty tool policy names");
  }
  let schema: Record<string, unknown> | undefined;
  if (outputSchema !== undefined) {
    if (!isRecord(outputSchema) || !isPluginJsonValue(outputSchema)) {
      return fail("outputSchema must be a bounded JSON Schema object");
    }
    // Admission copies caller data before validating and retains no mutable plugin object.
    schema = structuredClone(outputSchema);
    validateJsonSchemaValue({ schema: structuredClone(outputSchema), value: {}, cache: false });
  }
  const filePath = path.resolve(record.rootDir!, instructionsFile);
  const opened = openPluginRootFileSync({
    rootPath: record.rootDir!,
    filePath,
    rejectHardlinks: true,
    maxBytes: MAX_INSTRUCTIONS_BYTES,
  });
  if (!opened.ok) {
    return fail(
      describeRootFileOpenFailure({
        failure: opened,
        subject: "instructions file",
        boundaryLabel: "plugin package",
        filePath,
      }),
    );
  }
  let bytes: Buffer;
  try {
    bytes = readFileDescriptorBoundedSync(opened.fd, MAX_INSTRUCTIONS_BYTES);
  } finally {
    fs.closeSync(opened.fd);
  }
  const profile: RegisteredSubagentProfile = {
    pluginId: record.id,
    id,
    description,
    instructionsFile,
    instructionsSha256: createHash("sha256").update(bytes).digest("hex"),
    instructions: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    deny: [...new Set(tools?.deny ?? [])],
    ...(schema ? { outputSchema: schema } : {}),
  };
  state.registry.subagentProfiles.push(freezeJsonSnapshot(profile));
}
