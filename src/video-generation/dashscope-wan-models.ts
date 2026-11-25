import type {
  VideoGenerationCatalogModelEntry,
  VideoGenerationProviderCapabilities,
} from "./types.js";

export const DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL = "wan2.6-t2v";
export const DASHSCOPE_WAN_VIDEO_MODELS = [
  DEFAULT_DASHSCOPE_WAN_VIDEO_MODEL,
  "wan2.6-i2v",
  "wan2.6-r2v",
  "wan2.6-r2v-flash",
  "wan2.7-r2v",
];

const DASHSCOPE_WAN_VIDEO_RESOLUTIONS = ["720P", "1080P"] as const;
const DASHSCOPE_WAN_VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
const DASHSCOPE_WAN_LONG_VIDEO_DURATIONS = [
  2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
] as const;
const DASHSCOPE_WAN_SHORT_VIDEO_DURATIONS = [2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export const DASHSCOPE_WAN_VIDEO_SIZE_BY_GEOMETRY: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "480P": {
    "16:9": "832*480",
    "9:16": "480*832",
    "1:1": "624*624",
  },
  "720P": {
    "16:9": "1280*720",
    "9:16": "720*1280",
    "1:1": "960*960",
    "4:3": "1088*832",
    "3:4": "832*1088",
  },
  "1080P": {
    "16:9": "1920*1080",
    "9:16": "1080*1920",
    "1:1": "1440*1440",
    "4:3": "1632*1248",
    "3:4": "1248*1632",
  },
};
const DASHSCOPE_WAN_VIDEO_SIZES = DASHSCOPE_WAN_VIDEO_RESOLUTIONS.flatMap((resolution) =>
  Object.values(DASHSCOPE_WAN_VIDEO_SIZE_BY_GEOMETRY[resolution] ?? {}),
);

export const DASHSCOPE_WAN_VIDEO_CAPABILITIES = {
  generate: {
    maxVideos: 1,
    maxDurationSeconds: 15,
    supportedDurationSeconds: DASHSCOPE_WAN_LONG_VIDEO_DURATIONS,
    sizes: DASHSCOPE_WAN_VIDEO_SIZES,
    aspectRatios: DASHSCOPE_WAN_VIDEO_ASPECT_RATIOS,
    resolutions: DASHSCOPE_WAN_VIDEO_RESOLUTIONS,
    supportsSize: true,
    supportsAspectRatio: true,
    supportsResolution: true,
    supportsAudio: true,
    supportsWatermark: true,
  },
  imageToVideo: {
    enabled: true,
    maxVideos: 1,
    maxInputImages: 1,
    maxDurationSeconds: 15,
    supportedDurationSeconds: DASHSCOPE_WAN_LONG_VIDEO_DURATIONS,
    resolutions: DASHSCOPE_WAN_VIDEO_RESOLUTIONS,
    supportsSize: false,
    supportsAspectRatio: false,
    supportsResolution: true,
    supportsAudio: true,
    supportsWatermark: true,
  },
  videoToVideo: {
    enabled: true,
    maxVideos: 1,
    maxInputImages: 5,
    maxInputVideos: 3,
    maxDurationSeconds: 10,
    supportedDurationSeconds: DASHSCOPE_WAN_SHORT_VIDEO_DURATIONS,
    sizes: DASHSCOPE_WAN_VIDEO_SIZES,
    aspectRatios: DASHSCOPE_WAN_VIDEO_ASPECT_RATIOS,
    resolutions: DASHSCOPE_WAN_VIDEO_RESOLUTIONS,
    supportsSize: true,
    supportsAspectRatio: true,
    supportsResolution: true,
    supportsAudio: true,
    supportsWatermark: true,
  },
} satisfies VideoGenerationProviderCapabilities;

const disabledVideoTransform = { enabled: false } as const;
const dashscopeWanR2vCapabilities = {
  ...DASHSCOPE_WAN_VIDEO_CAPABILITIES,
  imageToVideo: {
    ...DASHSCOPE_WAN_VIDEO_CAPABILITIES.videoToVideo,
    enabled: true,
  },
};

// One model catalog drives both agent-visible modes and request-local runtime
// capability overlays, so the tool cannot advertise a mode the model rejects.
export const DASHSCOPE_WAN_VIDEO_CATALOG_BY_MODEL: Readonly<
  Record<string, VideoGenerationCatalogModelEntry>
> = {
  "wan2.6-t2v": {
    modes: ["generate", "imageToVideo"],
    capabilities: {
      generate: DASHSCOPE_WAN_VIDEO_CAPABILITIES.generate,
      // A single image routes to the cataloged I2V sibling before submission.
      imageToVideo: DASHSCOPE_WAN_VIDEO_CAPABILITIES.imageToVideo,
      videoToVideo: disabledVideoTransform,
    },
  },
  "wan2.6-i2v": {
    modes: ["imageToVideo"],
    capabilities: {
      imageToVideo: DASHSCOPE_WAN_VIDEO_CAPABILITIES.imageToVideo,
      videoToVideo: disabledVideoTransform,
    },
  },
  "wan2.6-r2v": {
    modes: ["imageToVideo", "videoToVideo"],
    capabilities: dashscopeWanR2vCapabilities,
  },
  "wan2.6-r2v-flash": {
    modes: ["imageToVideo", "videoToVideo"],
    capabilities: dashscopeWanR2vCapabilities,
  },
  "wan2.7-r2v": {
    modes: ["imageToVideo", "videoToVideo"],
    capabilities: {
      ...dashscopeWanR2vCapabilities,
      imageToVideo: {
        ...dashscopeWanR2vCapabilities.imageToVideo,
        supportsAspectRatio: true,
        supportsAudio: false,
      },
      videoToVideo: {
        ...dashscopeWanR2vCapabilities.videoToVideo,
        supportsAspectRatio: true,
        supportsAudio: false,
      },
    },
  },
};
