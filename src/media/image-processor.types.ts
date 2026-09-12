import type {
  EncodedImage,
  EncodeOptions,
  ImageTransparency,
  RastermillErrorCode,
} from "rastermill";

export type ImageProcessorOperation =
  | { kind: "encode"; options?: EncodeOptions }
  | { kind: "transparency" }
  | { kind: "bmpToPng" };

export type ImageProcessorRequest = { input: Uint8Array<ArrayBuffer> } & ImageProcessorOperation;

export type ImageProcessorReply =
  | { kind: "encode"; value: Omit<EncodedImage, "data"> & { data: Uint8Array<ArrayBuffer> } }
  | { kind: "transparency"; value: ImageTransparency }
  | { kind: "bmpToPng"; value: Uint8Array<ArrayBuffer> }
  | { kind: "failed"; error: Error; code?: RastermillErrorCode; unavailable: boolean };
