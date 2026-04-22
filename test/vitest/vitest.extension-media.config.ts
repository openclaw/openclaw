import { createScopedVitestConfig } from "./vitest.scoped-config.ts";

export default createScopedVitestConfig(
  [
    "alibaba/**/*.test.ts",
    "deepgram/**/*.test.ts",
    "elevenlabs/**/*.test.ts",
    "fal/**/*.test.ts",
    "image-generation-core/**/*.test.ts",
    "runway/**/*.test.ts",
    "talk-voice/**/*.test.ts",
    "video-generation-core/**/*.test.ts",
    "vydra/**/*.test.ts",
    "xiaomi/**/*.test.ts",
  ],
  {
    dir: "extensions",
    name: "extension-media",
    passWithNoTests: true,
    setupFiles: ["test/setup.extensions.ts"],
  },
);
