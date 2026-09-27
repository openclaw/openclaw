import { expect, it } from "vitest";
import { shouldFallbackFromPluginDescriptorCopy } from "./plugin-source-file.js";

const errno = (code: string) => Object.assign(new Error(code), { code });

const fallbackCases: {
  label: string;
  code: string;
  platform: NodeJS.Platform;
  isBun: boolean;
  expected: boolean;
}[] = [
  { label: "Bun Darwin EBADF", code: "EBADF", platform: "darwin", isBun: true, expected: true },
  { label: "Node Darwin EBADF", code: "EBADF", platform: "darwin", isBun: false, expected: false },
  { label: "Bun Linux EBADF", code: "EBADF", platform: "linux", isBun: true, expected: false },
  {
    label: "Bun Darwin unrelated error",
    code: "EIO",
    platform: "darwin",
    isBun: true,
    expected: false,
  },
  {
    label: "existing ENOENT fallback",
    code: "ENOENT",
    platform: "linux",
    isBun: false,
    expected: true,
  },
];

it.each(fallbackCases)(
  "classifies descriptor-copy fallback: $label",
  ({ code, platform, isBun, expected }) => {
    expect(shouldFallbackFromPluginDescriptorCopy(errno(code), platform, isBun)).toBe(expected);
  },
);
