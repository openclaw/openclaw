import photon from "@silvia-odwyer/photon-node";

/** Decode validated BMP bytes only after Rastermill rejects the format. */
export function convertBmpToPngWithPhoton(buffer: Uint8Array): Uint8Array {
  let image: InstanceType<typeof photon.PhotonImage> | undefined;
  try {
    image = photon.PhotonImage.new_from_byteslice(buffer);
    // Photon copies PNG bytes out of WASM, so these bytes survive image.free().
    return image.get_bytes();
  } finally {
    image?.free();
  }
}
