export type ImageLightboxItem = {
  kind?: "image" | "video";
  src: string;
  originalSrc?: string;
  title: string;
  release?: () => void;
  gallery?: ImageLightboxGallery;
};

export type ImageLightboxGallery = {
  index: number;
  items: readonly ((retryFailed?: boolean) => Promise<ImageLightboxItem | null>)[];
};
