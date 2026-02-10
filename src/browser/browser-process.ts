import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { BrowserExecutable } from "./chrome.executables.js";

/**
 * Shared type representing a running browser process (Chrome or Firefox).
 * `cdpPort` is the CDP debugging port for Chromium; for Firefox it is
 * carried over from the profile config for compatibility but is not a real
 * CDP endpoint (Playwright manages Firefox via Marionette internally).
 */
export type RunningBrowser = {
  pid: number;
  exe: BrowserExecutable;
  userDataDir: string;
  cdpPort: number;
  startedAt: number;
  proc: ChildProcessWithoutNullStreams;
  engine: "chromium" | "firefox";
  /** Profile name that launched this browser (used for Firefox context lookup). */
  profileName: string;
};
