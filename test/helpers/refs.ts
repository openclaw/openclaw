import { readWindowsFileExtents } from "@openclaw/fs-safe/test-hooks";

type FileExtent = { vcn: bigint; nextVcn: bigint; lcn: bigint };

/** Compare physical mappings independently of the clone implementation. */
export function getRefsFileExtents(filePath: string): FileExtent[] {
  return readWindowsFileExtents(filePath).map(({ vcn, lcn, clusters }) => ({
    vcn,
    nextVcn: vcn + clusters,
    lcn,
  }));
}
