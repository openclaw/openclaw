import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import {
  GatewayServiceDefinitionBackupReceiptSchema,
  matchesServiceFilePublication,
  matchesServiceFileState,
} from "./service-stage.js";

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
});

describe("service backup receipt identity compatibility", () => {
  it.each(["9007199254740992", "-9007199254740992"])(
    "reads released numeric receipts and preserves full-width ID %s",
    (ino) => {
      const state = {
        sha256: "a".repeat(64),
        mode: 0o600,
        dev: 7,
        ino: 42,
        size: 10,
        mtimeMs: 1,
        ctimeMs: 1,
      };
      const input = {
        id: "00000000-0000-4000-8000-000000000000",
        files: [{ sourcePath: path.resolve("legacy.service"), before: state, after: state }],
        guards: [],
      };
      const legacy = GatewayServiceDefinitionBackupReceiptSchema.parse(input).files[0]!.after!;
      expect(legacy).toMatchObject({ dev: 7, ino: 42 });
      expect(matchesServiceFilePublication({ ...legacy, dev: "7", ino: "42" }, legacy)).toBe(true);

      const fullWidth = { ...state, ino };
      const exact = GatewayServiceDefinitionBackupReceiptSchema.parse({
        ...input,
        files: [{ ...input.files[0], after: fullWidth }],
      }).files[0]!.after!;
      expect(matchesServiceFilePublication({ ...exact }, exact)).toBe(true);
      for (const field of ["mtimeMs", "ctimeMs"] as const) {
        const settled = { ...exact, [field]: exact[field] + 10 };
        expect(matchesServiceFilePublication(settled, exact)).toBe(true);
        expect(matchesServiceFileState(settled, exact)).toBe(false);
      }
      expect(matchesServiceFilePublication({ ...exact, sha256: "b".repeat(64) }, exact)).toBe(
        false,
      );
      expect(
        matchesServiceFilePublication({ ...exact, ino: (BigInt(ino) + 1n).toString() }, exact),
      ).toBe(false);
    },
  );

  it.each([
    { field: "ino", exactId: "9007199254740992", legacyId: 9007199254740992 },
    { field: "ino", exactId: "-9223372036854775808", legacyId: 9223372036854775808 },
    { field: "dev", exactId: "-9223372036854775808", legacyId: 9223372036854775808 },
  ] as const)(
    "keeps rounded legacy $field $exactId explicit while exact receipts detect a same-double replacement",
    ({ field, exactId, legacyId }) => {
      const state = {
        sha256: "a".repeat(64),
        mode: 0o600,
        dev: "7",
        ino: "42",
        size: 10,
        mtimeMs: 1,
        ctimeMs: 1,
        [field]: exactId,
      };
      const legacy = GatewayServiceDefinitionBackupReceiptSchema.parse({
        id: "00000000-0000-4000-8000-000000000000",
        files: [
          {
            sourcePath: path.resolve("legacy.service"),
            before: null,
            after: {
              ...state,
              dev: 7,
              ino: 42,
              [field]: legacyId,
            },
          },
        ],
        guards: [],
      }).files[0]!.after!;
      expect(legacy[field]).toBe(legacyId);
      expect(matchesServiceFilePublication(state, legacy)).toBe(true);
      expect(matchesServiceFilePublication({ ...state, [field]: legacyId }, legacy)).toBe(true);
      expect(matchesServiceFilePublication(state, state)).toBe(true);
      const replacedId = BigInt(exactId) + 1n;
      const replaced = { ...state, [field]: replacedId.toString() };
      expect(Number(BigInt.asUintN(64, replacedId))).toBe(legacyId);
      expect(matchesServiceFilePublication(replaced, legacy)).toBe(true);
      expect(matchesServiceFilePublication(replaced, state)).toBe(false);
    },
  );
});
