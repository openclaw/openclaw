type InstalledPluginIndexRecordWithOwner = {
  installOwner?: string;
  installOwnerAmbiguous?: true;
};

export function recordInstalledPluginIndexInstallOwner<T extends object>(
  record: T,
  installOwner: string | undefined,
  ambiguous = false,
): T {
  if (!installOwner && !ambiguous) {
    return record;
  }
  const ownedRecord = record as T & InstalledPluginIndexRecordWithOwner;
  if (ambiguous) {
    delete ownedRecord.installOwner;
    ownedRecord.installOwnerAmbiguous = true;
  } else {
    ownedRecord.installOwner = installOwner;
    delete ownedRecord.installOwnerAmbiguous;
  }
  return record;
}

export function resolveInstalledPluginIndexInstallOwner(record: object): string | undefined {
  const ownedRecord = record as InstalledPluginIndexRecordWithOwner;
  return ownedRecord.installOwnerAmbiguous ? undefined : ownedRecord.installOwner || undefined;
}

export function isInstalledPluginIndexInstallOwnerAmbiguous(record: object): boolean {
  // SAFETY: recordInstalledPluginIndexInstallOwner owns these optional record markers.
  return Boolean((record as InstalledPluginIndexRecordWithOwner).installOwnerAmbiguous);
}
