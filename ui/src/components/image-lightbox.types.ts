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
};

export type ImageLightboxGallery = {
  index: number;
  items: readonly ((retryFailed?: boolean) => Promise<ImageLightboxItem | null>)[];
};
