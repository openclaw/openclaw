import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import {
  GatewayServiceDefinitionBackupReceiptSchema,
  matchesServiceFilePublication as matchesPublication,
  matchesServiceFileState as matchesState,
} from "./service-stage.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const fileState = {
  sha256: "a".repeat(64),
  mode: 0o600,
  dev: 7,
  ino: 42,
  size: 10,
  mtimeMs: 1,
  ctimeMs: 1,
};
function readReceipt(after: unknown, before: unknown = null) {
  return GatewayServiceDefinitionBackupReceiptSchema.parse({
    id: "00000000-0000-4000-8000-000000000000",
    files: [{ sourcePath: path.resolve("legacy.service"), before, after }],
    guards: [],
  }).files[0]!.after!;
}

it.skipIf(process.platform === "win32").each([0o000, 0o077])(
  "publishes explicit modes before rename under umask %i",
  async (umask) => {
    const home = dirs.make("openclaw-service-modes-");
    const script = `
      import fs from "node:fs/promises";
      import path from "node:path";
      import { publishServiceFile } from ${JSON.stringify(new URL("./service-stage.ts", import.meta.url).href)};
      import { writeTaskXmlTempFile } from ${JSON.stringify(new URL("./schtasks-xml.ts", import.meta.url).href)};
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
it.each(["9007199254740992", "-9007199254740992"])(
  "reads released numeric receipts and preserves full-width ID %s",
  (ino) => {
    const legacy = readReceipt(fileState, fileState);
    expect(legacy).toMatchObject({ dev: 7, ino: 42 });
    expect(matchesPublication({ ...legacy, dev: "7", ino: "42" }, legacy)).toBe(true);

    const exact = readReceipt({ ...fileState, ino }, fileState);
    for (const field of ["mtimeMs", "ctimeMs"] as const) {
      const settled = { ...exact, [field]: exact[field] + 10 };
      expect([matchesPublication(settled, exact), matchesState(settled, exact)]).toEqual([
        true,
        false,
      ]);
    }
    expect(matchesPublication({ ...exact, sha256: "b".repeat(64) }, exact)).toBe(false);
    expect(matchesPublication({ ...exact, ino: (BigInt(ino) + 1n).toString() }, exact)).toBe(false);
  },
);

it.each([
  { field: "ino", exactId: "9007199254740992", legacyId: 9007199254740992 },
  { field: "ino", exactId: "-9223372036854775808", legacyId: 9223372036854775808 },
  { field: "dev", exactId: "-9223372036854775808", legacyId: 9223372036854775808 },
] as const)(
  "distinguishes rounded legacy from exact $field=$exactId receipts",
  ({ field, exactId, legacyId }) => {
    const state = {
      ...fileState,
      dev: "7",
      ino: "42",
      [field]: exactId,
    };
    const legacy = readReceipt({ ...fileState, [field]: legacyId });
    expect(legacy[field]).toBe(legacyId);
    expect(matchesPublication(state, legacy)).toBe(true);
    expect(matchesPublication({ ...state, [field]: legacyId }, legacy)).toBe(true);
    expect(matchesPublication(state, state)).toBe(true);
    const replacedId = BigInt(exactId) + 1n;
    const replaced = { ...state, [field]: replacedId.toString() };
    expect([matchesPublication(replaced, legacy), matchesPublication(replaced, state)]).toEqual([
      true,
      false,
    ]);
  },
);
