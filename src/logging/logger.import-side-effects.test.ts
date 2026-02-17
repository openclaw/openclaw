import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("logger import side effects", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not mkdir at import time", async () => {
    const mkdirSpy = vi.spyOn(fs, "mkdirSync");

    await import("./logger.js");

    expect(mkdirSpy).not.toHaveBeenCalled();
  });
});
