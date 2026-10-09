import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { copyPluginSourceFile } from "./plugin-source-file.js";

const tempDirs = createTempDirTracker();
afterEach(tempDirs.cleanup);

describe("copyPluginSourceFile", () => {
  function createFixture() {
    const root = tempDirs.make("openclaw-plugin-source-file-");
    const source = path.join(root, "source.txt");
    const targetDir = path.join(root, "target");
    const target = path.join(targetDir, "source.txt");
    fs.mkdirSync(targetDir);
    fs.writeFileSync(source, "source content");
    return { root, source, target, targetDir };
  }

  it("delegates fallback-free source capture to the guarded root copy API", () => {
    const { root, source, target, targetDir } = createFixture();
    const admitted = fs.statSync(source, { bigint: true });
    const observed: unknown[] = [];

    copyPluginSourceFile(source, root, target, {
      copyFile: (options) => {
        observed.push(options);
        const fd = fs.openSync(
          options.destination.absolutePath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
          options.mode,
        );
        fs.writeSync(fd, "copied by guard");
        return {
          fd,
          sourceIdentity: { dev: admitted.dev, ino: admitted.ino },
          [Symbol.dispose]() {
            fs.closeSync(fd);
          },
        };
      },
    });

    expect(observed).toEqual([
      expect.objectContaining({
        source: { rootPath: root, absolutePath: source },
        destination: { rootPath: targetDir, absolutePath: target },
        expectedSourceIdentity: { dev: admitted.dev, ino: admitted.ino },
        clone: "auto",
        maxBytes: Number(admitted.size),
        sourceHardlinks: "allow",
      }),
    ]);
    expect(fs.readFileSync(target, "utf8")).toBe("copied by guard");
  });

  it("preserves an existing destination when guarded exclusive creation collides", () => {
    const { root, source, target } = createFixture();
    fs.writeFileSync(target, "pre-existing content");

    expect(() => copyPluginSourceFile(source, root, target)).toThrow(/already exists/i);
    expect(fs.readFileSync(target, "utf8")).toBe("pre-existing content");
  });

  it("does not remove a destination replacement reported by guarded copying", () => {
    const { root, source, target } = createFixture();

    expect(() =>
      copyPluginSourceFile(source, root, target, {
        copyFile: (options) => {
          fs.writeFileSync(options.destination.absolutePath, "replacement content");
          throw new Error("guarded copy failed after replacement");
        },
      }),
    ).toThrow("guarded copy failed after replacement");

    expect(fs.readFileSync(target, "utf8")).toBe("replacement content");
  });
});
