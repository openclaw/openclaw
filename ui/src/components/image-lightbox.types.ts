export type ImageLightboxItem = {
  kind?: "image" | "video";
  src: string;
  originalSrc?: string;
  title: string;
  width?: number;
  height?: number;
  release?: () => void;
  loadFullResolution?: () => Promise<ImageLightboxItem | null>;
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
