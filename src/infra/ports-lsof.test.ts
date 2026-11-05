// Tests lsof parsing for port-to-process diagnostics.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveLsofCommand, resolveLsofCommandSync } from "./ports-lsof.js";

const LSOF_CANDIDATES =
  process.platform === "darwin"
    ? ["/usr/sbin/lsof", "/usr/bin/lsof"]
    : ["/usr/bin/lsof", "/usr/sbin/lsof"];

describe("lsof command resolution", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prefers the first executable async candidate", async () => {
    const accessSpy = vi.spyOn(fsPromises, "access").mockImplementation(async (target) => {
      if (target === LSOF_CANDIDATES[0]) {
        return;
      }
      throw new Error("unexpected");
    });

    await expect(resolveLsofCommand()).resolves.toBe(LSOF_CANDIDATES[0]);
    expect(accessSpy).toHaveBeenCalledTimes(1);
  });

  it("falls through async candidates before using the shell fallback", async () => {
    const accessSpy = vi.spyOn(fsPromises, "access").mockImplementation(async (target) => {
      if (target === LSOF_CANDIDATES[0]) {
        throw new Error("missing");
      }
      if (target === LSOF_CANDIDATES[1]) {
        return;
      }
      throw new Error("unexpected");
    });

    await expect(resolveLsofCommand()).resolves.toBe(LSOF_CANDIDATES[1]);
    expect(accessSpy).toHaveBeenCalledTimes(2);

    accessSpy.mockImplementation(async () => {
      throw new Error("missing");
    });
    await expect(resolveLsofCommand()).resolves.toBe("lsof");
  });

  it("does not inspect another executable after a canceled filesystem read", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    const controller = new AbortController();
    const access = vi.spyOn(fsPromises, "access").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      throw new Error("missing");
    });
    const result = resolveLsofCommand(controller.signal).catch((error: unknown) => error);
    await entered.promise;
    const reason = new Error("settle deadline expired");
    controller.abort(reason);
    release.resolve();
    expect(await result).toBe(reason);
    expect(access).toHaveBeenCalledOnce();
  });

  it("mirrors candidate resolution for the sync helper", () => {
    const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation((target) => {
      if (target === LSOF_CANDIDATES[0]) {
        throw new Error("missing");
      }
      if (target === LSOF_CANDIDATES[1]) {
        return undefined;
      }
      throw new Error("unexpected");
    });

    expect(resolveLsofCommandSync()).toBe(LSOF_CANDIDATES[1]);
    expect(accessSpy).toHaveBeenCalledTimes(2);

    accessSpy.mockImplementation(() => {
      throw new Error("missing");
    });
    expect(resolveLsofCommandSync()).toBe("lsof");
  });
});
