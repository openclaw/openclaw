export type ImagePixels = Pick<ImageData, "width" | "height" | "data">;

/** Compare browser-normalized Canvas RGBA samples; count each changed pixel once. */
export function compareImagePixels(left: ImagePixels, right: ImagePixels) {
  if (left.width !== right.width || left.height !== right.height) {
    return null;
  }
  const data = new Uint8ClampedArray(left.data.length);
  let changedPixels = 0;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (
      left.data[offset] !== right.data[offset] ||
      left.data[offset + 1] !== right.data[offset + 1] ||
      left.data[offset + 2] !== right.data[offset + 2] ||
      left.data[offset + 3] !== right.data[offset + 3]
    ) {
      changedPixels += 1;
      data.set([255, 0, 255, 255], offset);
    }
  }
  return { changedPixels, totalPixels: left.width * left.height, data };
}
