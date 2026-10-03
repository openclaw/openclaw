// Package activation path guards must name the rejected recovery object in their diagnostic.
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { privatePackageActivationIdentity } from "./package-update-activation-paths.js";

it("names the rejected recovery object with the observed permission metadata", async () => {
  await withTestDir({ prefix: "openclaw-activation-paths-" }, async (base) => {
    const controlDirectory = path.join(base, "abc.control");
    await fs.mkdir(controlDirectory);
    await fs.chmod(controlDirectory, 0o750);
    expect(() => privatePackageActivationIdentity(controlDirectory, true)).toThrow(
      "object=abc.control, kind=directory, mode=0o750; required mode with no group/other bits",
    );

    const helper = path.join(base, "recovery.mjs");
    await fs.writeFile(helper, "x");
    await fs.chmod(helper, 0o600);
    await fs.link(helper, path.join(base, "recovery-link.mjs"));
    expect(() => privatePackageActivationIdentity(helper, false)).toThrow(
      "object=recovery.mjs, kind=file, mode=0o600, nlink=2; required mode with no group/other bits and nlink 1",
    );
  });
});

it("keeps the diagnostic free of the private state layout", async () => {
  await withTestDir({ prefix: "openclaw-activation-paths-" }, async (base) => {
    const journal = path.join(base, "operation.sqlite");
    await fs.writeFile(journal, "x");
    await fs.chmod(journal, 0o640);
    let message = "";
    try {
      privatePackageActivationIdentity(journal, false);
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("object=operation.sqlite");
    expect(message).toContain("mode=0o640");
    expect(message).not.toContain(base);
  });
});

it("accepts private single-link objects", async () => {
  await withTestDir({ prefix: "openclaw-activation-paths-" }, async (base) => {
    const anchor = path.join(base, "anchor");
    await fs.mkdir(anchor);
    await fs.chmod(anchor, 0o700);
    expect(privatePackageActivationIdentity(anchor, true)).toMatch(/^\d+:\d+$/u);

    const helper = path.join(base, "recovery.mjs");
    await fs.writeFile(helper, "x");
    await fs.chmod(helper, 0o600);
    expect(privatePackageActivationIdentity(helper, false)).toMatch(/^\d+:\d+$/u);
  });
});
