import fs from "node:fs";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "./test-helpers/temp-dir.js";
import { withEnv } from "./test-utils/env.js";
import {
  CONFIG_DIR,
  ensureDir,
  normalizeE164,
  pinConfigDir,
  resolveConfigDir,
  shortenHomeInString,
  shortenHomePath,
  sleep,
} from "./utils.js";

it("ensureDir creates nested directories", async () => {
  await withTestDir({ prefix: "openclaw-test-" }, async (tmp) => {
    const target = path.join(tmp, "nested", "dir");
    await ensureDir(target);
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe("sleep", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("clamps oversized sleep delays before scheduling", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const promise = sleep(Number.MAX_SAFE_INTEGER);
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    vi.advanceTimersByTime(MAX_TIMER_TIMEOUT_MS);
    await expect(promise).resolves.toBeUndefined();
  });

  it.each([true, false])("classifies cancellation (pre-aborted: %s)", async (preAborted) => {
    const controller = new AbortController();
    const reason = new Error(preAborted ? "cancelled" : "stop");
    if (preAborted) {
      controller.abort(reason);
    }
    const promise = sleep(preAborted ? 0 : 60_000, controller.signal);
    controller.abort(reason);
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "AbortError", message: "aborted", cause: reason });
  });

  it("resolves a non-aborted zero-duration wait without scheduling", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    await expect(sleep(0, new AbortController().signal)).resolves.toBeUndefined();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });
});

it.each([
  ["whatsapp:+1 (234) 567-8900", "+12345678900"],
  ["not a phone number", ""],
])("normalizeE164 normalizes %s", (input, expected) => {
  expect(normalizeE164(input)).toBe(expected);
});

const customConfig = { OPENCLAW_PROFILE: "work", OPENCLAW_CONFIG_PATH: "~/custom/c.json" };
it.each<[NodeJS.ProcessEnv, string]>([
  [{}, ".openclaw"],
  [{ OPENCLAW_PROFILE: " work " }, ".openclaw-work"],
  [{ OPENCLAW_PROFILE: "Default" }, ".openclaw"],
  [{ OPENCLAW_PROFILE: "bad profile" }, ".openclaw"],
  [customConfig, "custom"],
  [{ ...customConfig, OPENCLAW_STATE_DIR: "~/state" }, "state"],
])("resolves config root for %j", (overrides, directory) => {
  const home = path.resolve("config-dir-home");
  const selected = resolveConfigDir({ HOME: home, ...overrides }, () => home);
  expect(selected).toBe(path.join(home, directory));
});

it("re-pins the exported configuration root after startup environment selection", () => {
  const original = CONFIG_DIR;
  const selected = path.resolve("/tmp/openclaw-selected-config-root");
  try {
    expect(pinConfigDir({ OPENCLAW_STATE_DIR: selected })).toBe(selected);
    expect(CONFIG_DIR).toBe(selected);
  } finally {
    pinConfigDir({ OPENCLAW_STATE_DIR: original });
  }
});
const displayHome = path.resolve("/h");
it.each([
  [shortenHomePath, "undefined", `${displayHome}/c`, "~/c"],
  [shortenHomeInString, displayHome, `config: ${displayHome}/c`, "config: $OPENCLAW_HOME/c"],
] as const)("%s selects display prefix for %s", (shorten, home, input, expected) => {
  withEnv({ OPENCLAW_HOME: home, HOME: displayHome }, () => {
    expect(shorten(input)).toBe(expected);
  });
});

it.skipIf(process.platform === "win32").each([
  [shortenHomePath, "/h/a/w", "/h/a/w"],
  [shortenHomePath, "/h/A\\w", "/h/A\\w"],
  [shortenHomePath, "/h/A/w\\x", "$OPENCLAW_HOME/w\\x"],
  [shortenHomeInString, "config: /h/a/c", "config: /h/a/c"],
] as const)("%s respects POSIX boundaries: %s", (shorten, input, expected) => {
  withEnv({ OPENCLAW_HOME: "/h/A", HOME: "/home/other" }, () => {
    expect(shorten(input)).toBe(expected);
  });
});

it.skipIf(process.platform !== "win32")("shortenHomePath: relative Windows paths", () => {
  withEnv({ OPENCLAW_HOME: process.cwd() }, () => {
    expect(shortenHomePath(`relative${path.sep}workspace`)).toBe(`relative${path.sep}workspace`);
  });
});

it
  .skipIf(process.platform === "win32")
  .each<[string, string?, string?]>([
    ["/h", "~"],
    ["open /h/n, /h, /hi/x and /mnt/h/x", "open ~/n, ~, /hi/x and /mnt/h/x"],
    ["Stored in /h. Backup: /h.bak/x", "Stored in ~. Backup: /h.bak/x"],
    ["/h+old, /h./n, /h,old/x, /h:old/x, /h\\i/x, /mnt+/h/x"],
    ['PATH=/h:/bin:/h/bin; dirs=/tmp;/h ("/h")', 'PATH=~:/bin:~/bin; dirs=/tmp;~ ("~")'],
    ["at file:///h/a.js:5:3", "at file://~/a.js:5:3"],
    ["see /var/log/c.log", "see /var/log/c.log", "/"],
  ])("shortens diagnostic component boundaries: %s", (input, expected = input, home = "/h") => {
  withEnv({ OPENCLAW_HOME: undefined, HOME: home }, () => {
    expect(shortenHomeInString(input)).toBe(expected);
  });
});
it.skipIf(process.platform !== "win32").each([true, false])(
  "shortens Windows aliases (extended: %s)",
  async (extended) => {
    await withTestDir({ prefix: "openclaw-home-display-" }, async (home) => {
      const workspace = path.join(home, "workspace");
      await fs.promises.mkdir(workspace);
      const alias = extended ? `\\\\?\\${workspace.toUpperCase()}` : home.toUpperCase();
      expect(fs.statSync(alias).isDirectory()).toBe(true);
      withEnv({ OPENCLAW_HOME: home }, () => {
        expect(extended ? shortenHomePath(alias) : shortenHomeInString(`config: ${alias}\\c`)).toBe(
          extended ? `$OPENCLAW_HOME${path.sep}WORKSPACE` : "config: $OPENCLAW_HOME\\c",
        );
      });
    });
  },
);
