import { readCloneFileMetadata } from "@openclaw/fs-safe/copy";

/** APFS clone IDs identify shared data streams, independently of the copy operation. */
export async function getApfsCloneId(filePath: string): Promise<bigint> {
  const [metadata] = await readCloneFileMetadata([filePath]);
  if (!metadata) {
    throw new Error(`Filesystem did not return an APFS clone ID: ${filePath}`);
  }
  return metadata.cloneId;
}
