import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);

describe.skipIf(process.platform === "win32")("service publication permissions", () => {
  it.each([0o000, 0o077])(
    "publishes explicit modes before rename under umask %i",
    async (umask) => {
      const home = dirs.make("openclaw-service-modes-");
      const script = `
      import fs from "node:fs/promises";
      import path from "node:path";
      import { publishServiceFile } from ${JSON.stringify(new URL("./service-stage.ts", import.meta.url).href)};
      import { writeTaskXmlTempFile } from ${JSON.stringify(new URL("./schtasks-layout.ts", import.meta.url).href)};
      process.umask(${umask});
      const home = ${JSON.stringify(home)};
      await fs.chmod(home, 0o700);
      const rename = fs.rename.bind(fs);
      const publications = [];
      fs.rename = async (from, to) => {
        if (String(to).startsWith(path.join(home, "artifact-"))) {
          publications.push((await fs.stat(from)).mode & 0o7777);
        }
        await rename(from, to);
      };
      const published = [];
      for (const mode of [0o600, 0o644, 0o700, 0o755]) {
        const filePath = path.join(home, "artifact-" + mode);
        await publishServiceFile({ filePath, contents: "synthetic definition", mode });
        published.push((await fs.stat(filePath)).mode & 0o7777);
      }
      const xml = await writeTaskXmlTempFile("<Task>synthetic</Task>");
      const xmlMode = (await fs.stat(xml)).mode & 0o7777;
      await fs.rm(path.dirname(xml), { recursive: true, force: true });
      process.stdout.write(JSON.stringify({
        publications, published, xmlMode, directoryMode: (await fs.stat(home)).mode & 0o7777,
      }));
    `;
      const result = await runCliProcessChild({
        nodeArgs: ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", script],
        env: {
          PATH: process.env.PATH,
          HOME: home,
          OPENCLAW_STATE_DIR: path.join(home, "state"),
          TMPDIR: home,
        },
      });
      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        publications: [0o600, 0o644, 0o700, 0o755],
        published: [0o600, 0o644, 0o700, 0o755],
        xmlMode: 0o600,
        directoryMode: 0o700,
      });
    },
  );
});
