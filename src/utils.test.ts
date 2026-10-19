// Tests shared utility helpers used by CLI and runtime modules.
import fs from "node:fs";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAbortError } from "./infra/abort-signal.js";
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

describe("ensureDir", () => {
  it("creates nested directory", async () => {
    await withTestDir({ prefix: "openclaw-test-" }, async (tmp) => {
      const target = path.join(tmp, "nested", "dir");
      await ensureDir(target);
      expect(fs.existsSync(target)).toBe(true);
    });
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

  it("rejects a pre-aborted zero-duration wait with the canonical abort error", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);

    const error = await sleep(0, controller.signal).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "AbortError", message: "aborted", cause: reason });
    expect(isAbortError(error)).toBe(true);
  });

  it("resolves a non-aborted zero-duration wait without scheduling", async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    await expect(sleep(0, new AbortController().signal)).resolves.toBeUndefined();
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("removes abort listeners after normal resolution", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeListenerSpy = vi.spyOn(controller.signal, "removeEventListener");
    const promise = sleep(5, controller.signal);
    await vi.advanceTimersByTimeAsync(5);
    await expect(promise).resolves.toBeUndefined();
    expect(removeListenerSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("rejects cancellation with the canonical abort classification and cause", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const promise = sleep(60_000, controller.signal);

    controller.abort(reason);

    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toMatchObject({ name: "AbortError", message: "aborted", cause: reason });
    expect(isAbortError(error)).toBe(true);
  });
});

describe("normalizeE164", () => {
  it.each([
    ["whatsapp:+1 (234) 567-8900", "+12345678900"],
    ["not a phone number", ""],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeE164(input)).toBe(expected);
  });
});

describe("resolveConfigDir", () => {
  it("resolves the default config directory", () => {
    const root = path.resolve("config-dir-home");
    expect(resolveConfigDir({}, () => root)).toBe(path.join(root, ".openclaw"));
  });

  it("expands OPENCLAW_STATE_DIR using the provided env", () => {
    expect(
      resolveConfigDir({
        HOME: "/tmp/openclaw-home",
        OPENCLAW_STATE_DIR: "~/state",
      }),
    ).toBe(path.resolve("/tmp/openclaw-home", "state"));
  });

  it("re-pins the exported configuration root after startup environment selection", () => {
    const originalConfigDir = CONFIG_DIR;
    const selectedConfigDir = path.resolve("/tmp/openclaw-selected-config-root");
    try {
      expect(
        pinConfigDir({
          OPENCLAW_STATE_DIR: selectedConfigDir,
          OPENCLAW_TEST_FAST: "1",
        }),
      ).toBe(selectedConfigDir);
      expect(CONFIG_DIR).toBe(selectedConfigDir);
    } finally {
      pinConfigDir({
        OPENCLAW_STATE_DIR: originalConfigDir,
        OPENCLAW_TEST_FAST: "1",
      });
    }
  });
});

describe("shortenHomePath", () => {
  it("uses the effective home prefix for OPENCLAW_HOME=undefined", () => {
    withEnv({ OPENCLAW_HOME: "undefined", HOME: "/home/other" }, () => {
      expect(shortenHomePath(`${path.resolve("/home/other")}/.openclaw/openclaw.json`)).toBe(
        "~/.openclaw/openclaw.json",
      );
    });
  });

  it.skipIf(process.platform === "win32")("preserves POSIX home path boundaries and case", () => {
    withEnv({ OPENCLAW_HOME: "/srv/OpenClaw-Home", HOME: "/home/other" }, () => {
      expect(shortenHomePath("/srv/openclaw-home/workspace")).toBe("/srv/openclaw-home/workspace");
      expect(shortenHomePath("/srv/OpenClaw-Home\\workspace")).toBe(
        "/srv/OpenClaw-Home\\workspace",
      );
      expect(shortenHomePath("/srv/OpenClaw-Home/work\\space")).toBe("$OPENCLAW_HOME/work\\space");
    });
  });

  it.skipIf(process.platform !== "win32")("keeps relative Windows paths relative", () => {
    withEnv({ OPENCLAW_HOME: process.cwd() }, () => {
      expect(shortenHomePath(`relative${path.sep}workspace`)).toBe(`relative${path.sep}workspace`);
    });
  });

  it.skipIf(process.platform !== "win32")(
    "shortens real extended-length Windows home aliases without exposing the absolute path",
    async () => {
      await withTestDir({ prefix: "openclaw-home-display-" }, async (home) => {
        const workspace = path.join(home, "workspace");
        await fs.promises.mkdir(workspace);
        const extendedAlias = `\\\\?\\${workspace.toUpperCase()}`;
        expect(fs.statSync(extendedAlias).isDirectory()).toBe(true);

        withEnv({ OPENCLAW_HOME: home }, () => {
          const display = shortenHomePath(extendedAlias);
          expect(display).toBe(`$OPENCLAW_HOME${path.sep}WORKSPACE`);
          expect(display).not.toContain(home.toUpperCase());
        });
      });
    },
  );
});

describe("shortenHomeInString", () => {
  it("uses the explicit OPENCLAW_HOME prefix", () => {
    withEnv({ OPENCLAW_HOME: "/srv/openclaw-home", HOME: "/home/other" }, () => {
      expect(
        shortenHomeInString(
          `config: ${path.resolve("/srv/openclaw-home")}/.openclaw/openclaw.json`,
        ),
      ).toBe("config: $OPENCLAW_HOME/.openclaw/openclaw.json");
    });
  });

  it.skipIf(process.platform === "win32")(
    "keeps embedded POSIX home matching case-sensitive",
    () => {
      withEnv({ OPENCLAW_HOME: "/srv/OpenClaw-Home", HOME: "/home/other" }, () => {
        expect(shortenHomeInString("config: /srv/openclaw-home/openclaw.json")).toBe(
          "config: /srv/openclaw-home/openclaw.json",
        );
      });
    },
  );

  it.skipIf(process.platform === "win32")("replaces only whole home path components", () => {
    withEnv({ OPENCLAW_HOME: undefined, HOME: "/home/al" }, () => {
      expect(shortenHomeInString("/home/al")).toBe("~");
      expect(shortenHomeInString("/home/al/x")).toBe("~/x");
      expect(
        shortenHomeInString("open /home/al/notes, /home/al, /home/alice/x and /mnt/home/al/x"),
      ).toBe("open ~/notes, ~, /home/alice/x and /mnt/home/al/x");
      expect(shortenHomeInString("Stored in /home/al. Backup: /home/al.bak/x")).toBe(
        "Stored in ~. Backup: /home/al.bak/x",
      );
      const siblingPaths =
        "/home/al+old, /home/al./notes, /home/al,old/x, /home/al:old/x, /home/al\\ice/x, /mnt+/home/al/x";
      expect(shortenHomeInString(siblingPaths)).toBe(siblingPaths);
      expect(
        shortenHomeInString('PATH=/home/al:/usr/bin:/home/al/bin; dirs=/tmp;/home/al ("/home/al")'),
      ).toBe('PATH=~:/usr/bin:~/bin; dirs=/tmp;~ ("~")');
      expect(shortenHomeInString("at file:///home/al/app.js:5:3")).toBe("at file://~/app.js:5:3");
    });
    withEnv({ OPENCLAW_HOME: undefined, HOME: "/" }, () => {
      expect(shortenHomeInString("see /var/log/openclaw.log")).toBe("see /var/log/openclaw.log");
    });
  });

  it.skipIf(process.platform !== "win32")(
    "shortens real Windows home casing aliases inside diagnostic text",
    async () => {
      await withTestDir({ prefix: "openclaw-home-display-" }, async (home) => {
        const homeAlias = home.toUpperCase();
        expect(fs.statSync(homeAlias).isDirectory()).toBe(true);

        withEnv({ OPENCLAW_HOME: home }, () => {
          expect(shortenHomeInString(`config: ${homeAlias}\\openclaw.json`)).toBe(
            "config: $OPENCLAW_HOME\\openclaw.json",
          );
        });
      });
    },
  );
});
