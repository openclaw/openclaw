import fs from "node:fs";
import { readWindowsFileExtents } from "@openclaw/fs-safe/test-hooks";

/** Compare full-cluster mappings; ReFS may copy the final partial cluster. */
export function getRefsFullClusterLcns(filePath: string): bigint[] {
  const clusters =
    fs.statSync(filePath, { bigint: true }).size / BigInt(fs.statfsSync(filePath).bsize);
  const extents = readWindowsFileExtents(filePath);
  const locations: bigint[] = [];
  let index = 0;
  for (let vcn = 0n; vcn < clusters; vcn++) {
    let extent = extents[index];
    while (extent && extent.vcn + extent.clusters <= vcn) {
      extent = extents[++index];
    }
    if (!extent || extent.vcn > vcn) {
      throw new Error(`Missing full-cluster mapping for ${filePath}: ${vcn}`);
    }
    locations.push(extent.lcn < 0n ? -1n : extent.lcn + vcn - extent.vcn);
  }
  return locations;
}
