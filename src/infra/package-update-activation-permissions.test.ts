import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  privatePackageActivationIdentity,
  repairPackagePermissions,
} from "./package-update-activation-paths.js";

afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform === "win32")("private package recovery permissions", () => {
  it.each(["anchor", "control", "journal", "helper", "rollback-journal"] as const)(
    "repairs an owned %s without replacing its identity or contents",
    async (role) => {
      await withTestDir({ prefix: "activation-permissions-" }, async (root) => {
        const file = path.join(root, role);
        const directory = role === "anchor" || role === "control";
        if (directory) {
          fs.mkdirSync(file, { mode: 0o750 });
        } else {
          fs.writeFileSync(file, "retained bytes", { mode: 0o640 });
        }
        fs.chmodSync(file, directory ? 0o750 : 0o640);
        const before = fs.lstatSync(file);
        const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
        expect(privatePackageActivationIdentity(file, role)).toBe(`${before.dev}:${before.ino}`);
        expect(fs.lstatSync(file).mode & 0o777).toBe(directory ? 0o700 : 0o600);
        if (!directory) {
          expect(fs.readFileSync(file, "utf8")).toBe("retained bytes");
        }
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining(
            `${JSON.stringify(file)}: mode=${directory ? "0750" : "0640"} nlink=${before.nlink}`,
          ),
          { code: "OPENCLAW_PACKAGE_PERMISSIONS_REPAIRED" },
        );
        privatePackageActivationIdentity(file, role);
        expect(warn).toHaveBeenCalledTimes(1);
      });
    },
  );

  it.each([
    { change: "same-mode chmod", refused: false },
    { change: "extra hard link", refused: false },
    { change: "appended bytes", refused: true },
  ])(
    "repairs package content after $change since observation unless it changed (refused=$refused)",
    async ({ change, refused }) => {
      await withTestDir({ prefix: "package-permission-drift-" }, async (root) => {
        const file = path.join(root, "index.js");
        fs.writeFileSync(file, "export {};\n");
        fs.chmodSync(file, 0o664);
        const observed = fs.lstatSync(file, { bigint: true });
        if (change === "same-mode chmod") {
          fs.chmodSync(file, 0o664);
        } else if (change === "extra hard link") {
          fs.linkSync(file, path.join(root, "alias.js"));
        } else {
          fs.appendFileSync(file, "more");
        }
        expect(fs.lstatSync(file, { bigint: true }).ctimeNs).not.toBe(observed.ctimeNs);
        const repair = () => repairPackagePermissions(file, observed, 0o644);
        if (refused) {
          expect(repair).toThrow("object changed before permission repair");
          expect(fs.lstatSync(file).mode & 0o777).toBe(0o664);
          return;
        }
        repair();
        expect(fs.lstatSync(file).mode & 0o777).toBe(0o644);
        expect(fs.readFileSync(file, "utf8")).toBe("export {};\n");
      });
    },
  );

  it("refuses multiply linked or symbolic objects without changing their permissions", async () => {
    await withTestDir({ prefix: "activation-permissions-" }, async (root) => {
      const file = path.join(root, "operation.sqlite");
      fs.writeFileSync(file, "retained bytes", { mode: 0o640 });
      fs.chmodSync(file, 0o640);
      fs.linkSync(file, path.join(root, "hardlink"));
      expect(() => privatePackageActivationIdentity(file, "journal")).toThrow(`mode=0640 nlink=2`);
      expect(fs.lstatSync(file).mode & 0o777).toBe(0o640);
      const link = path.join(root, "symlink");
      fs.symlinkSync(file, link);
      expect(() => privatePackageActivationIdentity(link, "helper")).toThrow("unexpected type");
      expect(fs.readFileSync(file, "utf8")).toBe("retained bytes");
    });
  });

  it("reports the path and observed permissions when chmod cannot repair access", async () => {
    await withTestDir({ prefix: "activation-permissions-" }, async (root) => {
      const file = path.join(root, "operation.sqlite");
      fs.writeFileSync(file, "retained bytes", { mode: 0o640 });
      fs.chmodSync(file, 0o640);
      vi.spyOn(fs, "fchmodSync").mockImplementation(() => {
        throw new Error("read-only filesystem");
      });
      expect(() => privatePackageActivationIdentity(file, "journal")).toThrow(
        `Package recovery journal ${JSON.stringify(file)} unsafe: mode=0640 nlink=1`,
      );
      expect(() => privatePackageActivationIdentity(file, "journal")).toThrow(
        "read-only filesystem",
      );
      expect(fs.readFileSync(file, "utf8")).toBe("retained bytes");
    });
  });
});
