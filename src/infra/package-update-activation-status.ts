import {
  isPackageActivationComplete,
  resolvePackageActivationAnchor,
} from "./package-update-activation-paths.js";
import type {
  PackageActivationPhase,
  PackageActivationRecord,
} from "./package-update-activation-schema.js";

export function assertPackageActivationOperation(
  record: PackageActivationRecord,
  operationId: string,
): void {
  if (record.descriptor.operationId !== operationId) {
    throw new Error("Package recovery command belongs to a different operation.");
  }
}

export type PackageActivationStatus = {
  phase: PackageActivationPhase | "complete";
  operationId: string;
  installKey: string;
};

export function readPackageActivationRecordStatus(
  record: PackageActivationRecord,
): PackageActivationStatus {
  return {
    phase: isPackageActivationComplete(
      resolvePackageActivationAnchor(record.descriptor.authority.installKey),
      record,
    )
      ? "complete"
      : record.phase,
    operationId: record.descriptor.operationId,
    installKey: record.descriptor.authority.installKey,
  };
}
