import { randomUUID } from "node:crypto";
// IPC contract between package update parents and the post-install doctor child.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV =
  "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH";
export const UPDATE_POST_INSTALL_DOCTOR_ADVISORY_EXIT_CODE = 86;

export type PackageUpdateStepAdvisory = {
  kind: "package-post-install-doctor";
  message: string;
};

export const PACKAGE_POST_INSTALL_DOCTOR_ADVISORY: PackageUpdateStepAdvisory = {
  kind: "package-post-install-doctor",
  message:
    "Post-install doctor reported a recoverable update-time repair warning after the package install was verified; continuing with post-core plugin convergence and gateway restart.",
};

export type UpdatePostInstallDoctorResult = {
  status: "advisory";
  advisory: PackageUpdateStepAdvisory & {
    reason: "deferred-configured-plugin-repair";
    details: string[];
  };
};

export function createUpdatePostInstallDoctorResultPath(): string {
  return path.join(os.tmpdir(), `openclaw-update-doctor-${process.pid}-${randomUUID()}.json`);
}

export function createDeferredConfiguredPluginRepairDoctorResult(
  details: readonly string[],
): UpdatePostInstallDoctorResult {
  return {
    status: "advisory",
    advisory: {
      ...PACKAGE_POST_INSTALL_DOCTOR_ADVISORY,
      reason: "deferred-configured-plugin-repair",
      details: details.filter((line) => line.trim()),
    },
  };
}

export async function writeUpdatePostInstallDoctorResult(params: {
  resultPath: string;
  result: UpdatePostInstallDoctorResult;
}): Promise<void> {
  await fs.mkdir(path.dirname(params.resultPath), { recursive: true });
  await fs.writeFile(params.resultPath, `${JSON.stringify(params.result)}\n`, "utf8");
}

export async function consumeUpdatePostInstallDoctorResult(
  resultPath: string,
): Promise<UpdatePostInstallDoctorResult | null> {
  try {
    const raw = await fs.readFile(resultPath, "utf8");
    return parseUpdatePostInstallDoctorResult(JSON.parse(raw));
  } catch {
    return null;
  } finally {
    await fs.rm(resultPath, { force: true }).catch(() => {});
  }
}

function parseUpdatePostInstallDoctorResult(value: unknown): UpdatePostInstallDoctorResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.status !== "advisory") {
    return null;
  }
  const advisory = record.advisory;
  if (!advisory || typeof advisory !== "object") {
    return null;
  }
  const advisoryRecord = advisory as Record<string, unknown>;
  const details = advisoryRecord.details;
  if (
    advisoryRecord.kind !== "package-post-install-doctor" ||
    advisoryRecord.reason !== "deferred-configured-plugin-repair" ||
    typeof advisoryRecord.message !== "string" ||
    !Array.isArray(details) ||
    !details.every((entry): entry is string => typeof entry === "string")
  ) {
    return null;
  }
  return {
    status: "advisory",
    advisory: {
      kind: "package-post-install-doctor",
      reason: "deferred-configured-plugin-repair",
      message: advisoryRecord.message,
      details,
    },
  };
}
