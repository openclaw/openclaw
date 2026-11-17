import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as spawnOwner from "../process/spawn-utils.js";
import { openLocalFile } from "./browser-open.js";
import { discoverLinuxControlUiBrowsers } from "./control-ui-browser-linux.js";

const dirs = createTempDirTracker();
let root: string;
beforeEach(async () => {
  root = dirs.make("openclaw-linux-browser-");
  await fs.mkdir(path.join(root, "applications"));
  vi.stubEnv("PATH", root);
  vi.stubEnv("BROWSER", "");
  vi.stubEnv("XDG_DATA_HOME", root);
  vi.stubEnv("XDG_DATA_DIRS", root);
  for (const [name, output] of [
    ["xdg-mime", "firefox.desktop"],
    ["firefox", "Mozilla Firefox 140.0esr"],
    ["google-chrome", "Google Chrome 156.0.1"],
  ]) {
    await fs.writeFile(path.join(root, name!), '#!/bin/sh\nprintf "%s\\n" "' + output + '"\n', {
      mode: 0o700,
    });
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  dirs.cleanup();
});

it.runIf(process.platform === "linux")(
  "resolves the actual desktop executable and versions through bounded read-only subprocesses",
  async () => {
    await fs.writeFile(
      path.join(root, "applications", "firefox.desktop"),
      '[Desktop Entry]\nExec="' + path.join(root, "firefox") + '" --new-window %u\n',
    );
    const found = await discoverLinuxControlUiBrowsers();
    expect(found.defaultBrowser).toMatchObject({
      family: "firefox",
      version: "140.0",
      command: [path.join(root, "firefox")],
    });
    expect(found.alternatives.map((item) => [item.name, item.version])).toEqual([
      ["Chrome", "156.0.1"],
      ["Firefox", "140.0"],
    ]);
  },
);

it.runIf(process.platform === "linux")(
  "does not execute desktop command flags or guess env/Flatpak wrapper identity",
  async () => {
    await fs.writeFile(
      path.join(root, "applications", "firefox.desktop"),
      "[Desktop Entry]\nExec=env MOZ_FAKE=1 firefox %u\n",
    );
    expect((await discoverLinuxControlUiBrowsers()).defaultBrowser).toBeUndefined();
    vi.stubEnv("BROWSER", "custom-wrapper");
    expect(await discoverLinuxControlUiBrowsers()).toEqual({ alternatives: [] });
  },
);

it.runIf(process.platform === "linux")(
  "acknowledges a cold GUI startup without waiting for its lifetime or killing it",
  async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");
    let browser: ChildProcess | undefined;
    const spawn = spawnOwner.spawnAndWait;
    using observer = vi.spyOn(spawnOwner, "spawnAndWait");
    observer.mockImplementation(async (params) => {
      browser = await spawn(params);
      return browser;
    });
    try {
      expect(
        await openLocalFile(path.join(root, "handoff.html"), {
          browserCommand: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        }),
      ).toBe(true);
      expect(browser?.exitCode).toBe(null);
    } finally {
      if (browser) {
        const closed = once(browser, "close");
        browser.kill();
        await closed;
      }
    }
  },
);
