import type { SolidBridgeElement } from "../lib/solid-bridge.ts";

export type ImageLightboxItem = {
  kind?: "image" | "video";
  src: string;
  originalSrc?: string;
  title: string;
  width?: number;
  height?: number;
  release?: () => void;
  loadDisplayImage?: () => Promise<ImageLightboxItem | null>;
  readOriginalBlob?: () => Promise<Blob>;
  gallery?: ImageLightboxGallery;
  /** The source owner connects only the selected player and releases on navigation/close. */
  connectVideo?: (
    media: HTMLVideoElement,
    notify: (status: "preparing" | "ready" | "unavailable", retryable?: boolean) => void,
    retryFailed?: boolean,
  ) => () => void;
};

export type ImageLightboxGallery = {
  index: number;
  items: readonly ((retryFailed?: boolean) => Promise<ImageLightboxItem | null>)[];
};
export type ImageLightboxProps = {
  connectVideo?: ImageLightboxItem["connectVideo"];
  gallery?: ImageLightboxGallery;
  loadDisplayImage?: ImageLightboxItem["loadDisplayImage"];
  readOriginalBlob?: ImageLightboxItem["readOriginalBlob"];
  mediaKind: "image" | "video";
  src: string;
  originalSrc: string;
  imageTitle: string;
  imageWidth?: number;
  imageHeight?: number;
};

export type ImageLightboxElement = SolidBridgeElement<ImageLightboxProps>;
