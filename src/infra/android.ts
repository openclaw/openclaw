import { readFileSync } from "node:fs";

let androidCached: boolean | null = null;

export function isAndroidRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  if (androidCached !== null) {
    return androidCached;
  }
  const override = env.OPENCLAW_ANDROID?.trim().toLowerCase();
  if (override === "1" || override === "true" || override === "yes") {
    androidCached = true;
    return androidCached;
  }
  if (process.platform === "android") {
    androidCached = true;
    return androidCached;
  }
  if (process.platform !== "linux") {
    androidCached = false;
    return androidCached;
  }
  if (env.ANDROID_ROOT || env.ANDROID_DATA || env.ANDROID_STORAGE) {
    androidCached = true;
    return androidCached;
  }
  try {
    const release = readFileSync("/proc/sys/kernel/osrelease", "utf8").toLowerCase();
    if (release.includes("android")) {
      androidCached = true;
      return androidCached;
    }
  } catch {}
  try {
    const version = readFileSync("/proc/version", "utf8").toLowerCase();
    androidCached = version.includes("android");
    return androidCached;
  } catch {
    androidCached = false;
    return androidCached;
  }
}
