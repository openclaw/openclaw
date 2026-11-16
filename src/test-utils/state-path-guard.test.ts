import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as boundaryPath from "../infra/boundary-path.js";
import {
  openNodeSqliteDatabase,
  resolveExistingSqliteFileUri,
  resolveImmutableSqliteFileUri,
} from "../infra/node-sqlite.js";
import { cleanupSessionStateForTest } from "./session-state-cleanup.js";
import { useIsolatedStateGuard } from "./state-path-guard.js";

describe("isolated state path guard", () => {
  useIsolatedStateGuard();
  const ownedRoots = new Set<string>();
  const dirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      const results = await Promise.allSettled(
        [...ownedRoots].map((rootPath) =>
          cleanupSessionStateForTest({ stateDir: rootPath, rootPath }),
        ),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length) {
        throw new AggregateError(errors, "State path guard fixture cleanup failed");
      }
      cleanup();
      ownedRoots.clear();
    }),
  );
  const makeOwnedRoot = () => {
    const root = dirs.make("state-path-guard-", process.env.OPENCLAW_TEST_HOME);
    ownedRoots.add(root);
    return root;
  };

  it.each([
    { name: "filesystem path", location: (pathname: string) => pathname },
    { name: "existing URI", location: resolveExistingSqliteFileUri },
    { name: "immutable URI", location: resolveImmutableSqliteFileUri },
    {
      name: "encoded URI",
      location: (pathname: string) => `file:${encodeURIComponent(pathname)}?mode=ro#ignored`,
    },
  ])("opens the owned database through $name without changing options", ({ location }) => {
    const pathname = path.join(
      makeOwnedRoot(),
      process.platform === "win32" ? "state #%.sqlite" : "state ?#%.sqlite",
    );
    const initial = openNodeSqliteDatabase(pathname);
    try {
      initial.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('original')");
    } finally {
      initial.close();
    }
    const database = openNodeSqliteDatabase(location(pathname), {
      enableForeignKeyConstraints: false,
    });
    try {
      expect(database.prepare("SELECT value FROM retained").get()).toEqual({ value: "original" });
      expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
    } finally {
      database.close();
    }
  });

  it.each([false, true])("rejects an outside database before opening (URI=%s)", (uri) => {
    const pathname = path.join(dirs.make("state-path-guard-outside-"), "state.sqlite");
    expect(() => {
      openNodeSqliteDatabase(uri ? resolveExistingSqliteFileUri(pathname) : pathname).close();
    }).toThrow("OpenClaw state escaped the isolated test home");
    expect(fs.existsSync(pathname)).toBe(false);
  });

  it("rejects an owned URI whose parent symlink escapes the home", () => {
    const outside = dirs.make("state-path-guard-outside-");
    const link = path.join(makeOwnedRoot(), "linked");
    fs.symlinkSync(outside, link, "junction");
    const pathname = path.join(link, "state.sqlite");
    expect(() => openNodeSqliteDatabase(resolveExistingSqliteFileUri(pathname)).close()).toThrow(
      "OpenClaw state escaped the isolated test home",
    );
    expect(fs.existsSync(path.join(outside, "state.sqlite"))).toBe(false);
  });

  it.each(["raw", "file", "encoded"])("rejects NUL before normalizing a %s location", (form) => {
    const root = makeOwnedRoot();
    const location =
      form === "raw"
        ? path.join(root, "state\0.sqlite")
        : form === "file"
          ? `${resolveExistingSqliteFileUri(root).split("?")[0]}/ignored%00/../state.sqlite`
          : `file:${encodeURIComponent(root)}/ignored%00/../state.sqlite`;
    expect(() => openNodeSqliteDatabase(location).close()).toThrow(
      "State isolation checks reject NUL in SQLite paths.",
    );
    expect(fs.existsSync(path.join(root, "state.sqlite"))).toBe(false);
  });

  it("checks the decoded Windows producer path before opening", () => {
    const pathname = String.raw`Z:\outside-state\state ?#%.sqlite`;
    const namespaced = String.raw`\\?\Z:\outside-state\state ?#%.sqlite`;
    const resolveIdentity = vi.spyOn(boundaryPath, "resolveIdentityPathViaExistingAncestorSync");
    try {
      expect(() =>
        openNodeSqliteDatabase(resolveExistingSqliteFileUri(pathname, "win32")).close(),
      ).toThrow("OpenClaw state escaped the isolated test home");
      expect(resolveIdentity).toHaveBeenCalledWith(namespaced);
    } finally {
      resolveIdentity.mockRestore();
    }
  });
});
