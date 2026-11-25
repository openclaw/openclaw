import { createContext } from "solid-js";
import type { ImageLightboxElement } from "./image-lightbox.types.ts";

export const ImageLightboxHost = createContext<ImageLightboxElement>();
