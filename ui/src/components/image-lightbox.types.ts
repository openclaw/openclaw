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
