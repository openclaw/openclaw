import type { ProviderStreamOptions } from "@mariozechner/pi-ai";
import type { ImageDescriptionRequest, ImageDescriptionResult, ImagesDescriptionRequest, ImagesDescriptionResult } from "./types.js";
export declare function describeImagesWithModel(params: ImagesDescriptionRequest): Promise<ImagesDescriptionResult>;
export declare function describeImagesWithModelPayloadTransform(params: ImagesDescriptionRequest, onPayload: ProviderStreamOptions["onPayload"]): Promise<ImagesDescriptionResult>;
export declare function describeImageWithModel(params: ImageDescriptionRequest): Promise<ImageDescriptionResult>;
export declare function describeImageWithModelPayloadTransform(params: ImageDescriptionRequest, onPayload: ProviderStreamOptions["onPayload"]): Promise<ImageDescriptionResult>;
