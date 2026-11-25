import { readImageProbeFromHeader, type ImageMetadata, type ImageProbe } from "rastermill";

export function resolveDisplayImageMetadata(probe: ImageProbe | null): ImageMetadata | null {
  if (!probe) {
    return null;
  }
  // Rastermill reports encoded axes; orientations 5-8 swap the displayed axes.
  if (probe.orientation && probe.orientation >= 5 && probe.orientation <= 8) {
    return { width: probe.height, height: probe.width };
  }
  return { width: probe.width, height: probe.height };
}

/** Reads display dimensions from image header bytes without invoking a full image decode. */
export function readImageMetadataFromHeader(buffer: Buffer): ImageMetadata | null {
  return resolveDisplayImageMetadata(readImageProbeFromHeader(buffer));
}
