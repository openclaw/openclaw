import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isPathInside,
  openPluginRootFileSync,
  relativePluginPathInsideRootSync,
} from "./path-safety.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function installWindowsPathFixture(params: {
  root: string;
  canonicalRoot?: string;
  source?: string;
}) {
  const directory = fs.statSync(new URL(".", import.meta.url), { bigint: true });
  const file = fs.statSync(new URL(import.meta.url), { bigint: true });
  const isWindowsPath = (value: string) => /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(value);
  const resolve = path.resolve;
  const dirname = path.dirname;
  const relative = path.relative;
  const isAbsolute = path.isAbsolute;
  const join = path.join;
  const parse = path.parse;
  const win32Resolve = path.win32.resolve;
  const win32Dirname = path.win32.dirname;
  const win32Relative = path.win32.relative;
  const win32IsAbsolute = path.win32.isAbsolute;
  const win32Join = path.win32.join;
  const win32Parse = path.win32.parse;
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(path, "resolve").mockImplementation((...parts) =>
    parts.some(isWindowsPath) ? win32Resolve(...parts) : resolve(...parts),
  );
  vi.spyOn(path, "dirname").mockImplementation((value) =>
    isWindowsPath(value) ? win32Dirname(value) : dirname(value),
  );
  vi.spyOn(path, "relative").mockImplementation((from, to) =>
    isWindowsPath(from) || isWindowsPath(to) ? win32Relative(from, to) : relative(from, to),
  );
  vi.spyOn(path, "isAbsolute").mockImplementation((value) =>
    isWindowsPath(value) ? win32IsAbsolute(value) : isAbsolute(value),
  );
  vi.spyOn(path, "join").mockImplementation((...parts) =>
    parts.some(isWindowsPath) ? win32Join(...parts) : join(...parts),
  );
  vi.spyOn(path, "parse").mockImplementation((value) =>
    isWindowsPath(value) ? win32Parse(value) : parse(value),
  );
  const statSync = fs.statSync;
  const stat = vi.spyOn(fs, "statSync").mockImplementation(((value, options) => {
    const name = String(value);
    if (!isWindowsPath(name)) {
      return statSync(value, options);
    }
    if (
      name === params.root ||
      name === params.canonicalRoot ||
      (params.source && name === win32Dirname(params.source))
    ) {
      return directory;
    }
    if (name === params.source) {
      return file;
    }
    // Never let synthetic UNC names reach a Windows network provider.
    throw Object.assign(new Error("synthetic path is absent"), { code: "ENOENT" });
  }) as typeof fs.statSync);
  const lstatSync = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation(((value, options) =>
    isWindowsPath(String(value))
      ? stat(value, options)
      : lstatSync(value, options)) as typeof fs.lstatSync);
  const realpathSync = fs.realpathSync;
  vi.spyOn(fs, "realpathSync").mockImplementation(
    (value: fs.PathLike, options?: fs.EncodingOption | fs.BufferEncodingOption) => {
      const encoding = typeof options === "string" ? options : options?.encoding;
      if (String(value) === params.root) {
        const resolved = Buffer.from(params.canonicalRoot ?? params.root);
        return encoding === "buffer" ? resolved : resolved.toString(encoding ?? "utf8");
      }
      if (params.source && String(value) === win32Dirname(params.source)) {
        const resolved = Buffer.from(String(value));
        return encoding === "buffer" ? resolved : resolved.toString(encoding ?? "utf8");
      }
      return encoding === "buffer"
        ? realpathSync(value, "buffer")
        : realpathSync(value, { encoding });
    },
  );
  return stat;
}

describe("Windows plugin alias admission", () => {
  it.each([
    String.raw`C:\Program Files\nodejs\node_modules\@openclaw\deepseek-provider`,
    String.raw`C:\Users\Tester\scoop\apps\nodejs\current\node_modules\@openclaw\deepseek-provider`,
  ])("opens a plugin beneath an ancestor junction at %s", (aliasRoot) => {
    const root = String.raw`D:\node-versions\24.19\node_modules\@openclaw\deepseek-provider`;
    const source = `${aliasRoot}\\index.js`;
    const canonicalSource = `${root}\\index.js`;
    const file = fs.statSync(new URL(import.meta.url), { bigint: true });
    const numericFile = fs.statSync(new URL(import.meta.url));
    const stat = installWindowsPathFixture({ root, source });
    const fixtureStat = stat.getMockImplementation()!;
    stat.mockImplementation(((value, options) =>
      String(value) === canonicalSource
        ? options?.bigint
          ? file
          : numericFile
        : fixtureStat(value, options)) as typeof fs.statSync);
    vi.mocked(fs.realpathSync).mockImplementation(((value: fs.PathLike) =>
      String(value).replace(aliasRoot, root)) as typeof fs.realpathSync);
    const open = vi.spyOn(fs, "openSync").mockReturnValue(123);
    const close = vi.spyOn(fs, "closeSync").mockImplementation(() => {});
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd, options) => {
      expect(fd).toBe(123);
      return options?.bigint ? file : numericFile;
    }) as typeof fs.fstatSync);

    const opened = openPluginRootFileSync({
      rootPath: aliasRoot,
      rootRealPath: root,
      filePath: source,
      rejectHardlinks: true,
    });
    try {
      expect(opened, !opened.ok ? String(opened.error) : undefined).toMatchObject({
        ok: true,
        path: canonicalSource,
        rootRealPath: root,
      });
      expect(open).toHaveBeenCalledWith(canonicalSource, expect.any(Number));
    } finally {
      if (opened.ok) {
        fs.closeSync(opened.fd);
      }
    }
    expect(close).toHaveBeenCalledWith(123);
  });

  it.each([
    {
      root: String.raw`C:\plugins\trusted`,
      targets: [
        String.raw`\\plugin-canary\share\index.js`,
        "//plugin-canary/share/index.js",
        String.raw`\\?\UNC\plugin-canary\share\index.js`,
        String.raw`\\.\UNC\plugin-canary\share\index.js`,
        String.raw`\\.\pipe\plugin-canary`,
        String.raw`\\?\GLOBALROOT\Device\Mup\plugin-canary\share\index.js`,
        String.raw`\\.\C:\..\UNC\plugin-canary\share\index.js`,
        String.raw`\\?\UNC\trusted\share\..\..\plugin-canary\share\index.js`,
      ],
      open: true,
    },
    ...(
      [
        [String.raw`\\plugin-kost\share\root`, String.raw`\\plugin-Kost\share\other\index.js`],
        [String.raw`\\plugin-kost\share\root`, String.raw`\\?\UNC\plugin-Kost\share\root\index.js`],
        [
          String.raw`\\?\GLOBALROOT\Device\HarddiskVolume1\root`,
          String.raw`\\?\GLOBALROOT\Device\Mup\plugin-canary\share\index.js`,
        ],
        [
          String.raw`\\?\UNC\trusted\share\..\..\plugin-canary\share\root`,
          String.raw`\\plugin-canary\share\other\index.js`,
        ],
      ] as const
    ).map(([root, target]) => ({ root, targets: [target], open: false })),
  ])("rejects foreign or ambiguous Windows aliases beneath $root", ({ root, targets, open }) => {
    const stat = installWindowsPathFixture({ root });
    for (const target of targets) {
      expect(isPathInside(root, target), target).toBe(false);
      expect(relativePluginPathInsideRootSync(root, target), target).toBeUndefined();
      if (open) {
        expect(
          openPluginRootFileSync({
            rootPath: root,
            rootRealPath: root,
            filePath: target,
            rejectHardlinks: false,
          }).ok,
          target,
        ).toBe(false);
      }
    }
    expect(
      stat.mock.calls.filter(([value]) =>
        open ? String(value).includes("plugin-canary") : String(value) !== root,
      ),
    ).toEqual([]);
  });

  it.each([
    [String.raw`C:\plugins\short`, String.raw`D:\plugins\long\index.js`],
    [String.raw`C:\plugins\short`, String.raw`\\?\D:\plugins\long\index.js`],
    [String.raw`C:\plugins\short`, String.raw`\\.\D:\plugins\long\index.js`],
    [String.raw`\\trusted\share\short`, String.raw`\\trusted\share\long\index.js`],
    [String.raw`\\?\UNC\trusted\share\short`, String.raw`\\trusted\share\long\index.js`],
  ])("retains physical identity checks for %s and %s", (root, source) => {
    const stat = installWindowsPathFixture({ root, source });
    expect(isPathInside(root, source)).toBe(true);
    expect(relativePluginPathInsideRootSync(root, source)).toBe("index.js");
    expect(stat).toHaveBeenCalledWith(root, { bigint: true });
    expect(stat).toHaveBeenCalledWith(path.win32.dirname(source), { bigint: true });
  });

  it("uses only the trusted root's canonical share to admit a local root alias", () => {
    const root = String.raw`C:\plugins\linked`;
    const canonicalRoot = String.raw`\\trusted\share\plugin`;
    const source = String.raw`\\trusted\share\plugin\index.js`;
    const stat = installWindowsPathFixture({ root, canonicalRoot, source });
    expect(isPathInside(root, source)).toBe(true);
    expect(relativePluginPathInsideRootSync(root, source)).toBe("index.js");
    const foreign = String.raw`\\plugin-canary\share\plugin\index.js`;
    expect(isPathInside(root, foreign)).toBe(false);
    expect(stat.mock.calls.filter(([value]) => String(value).includes("plugin-canary"))).toEqual(
      [],
    );
  });

  it.each([
    [String.raw`C:\Plugins\Root`, String.raw`c:\plugins\root\Nested\Entry.js`],
    [String.raw`C:\Plugins\Root`, String.raw`\\?\c:\plugins\root\Nested\Entry.js`],
    [String.raw`\\?\C:\Plugins\Root`, String.raw`c:\plugins\root\Nested\Entry.js`],
    [String.raw`\\?\C:\Plugins\Root`, String.raw`\\?\c:\plugins\root\Nested\Entry.js`],
    [String.raw`\\Trusted\Share\Root`, String.raw`\\trusted\share\root\Nested\Entry.js`],
    [String.raw`\\Trusted\Share\Root`, String.raw`\\?\UNC\trusted\share\root\Nested\Entry.js`],
    [String.raw`\\?\UNC\Trusted\Share\Root`, String.raw`\\trusted\share\root\Nested\Entry.js`],
    [
      String.raw`\\?\UNC\Trusted\Share\Root`,
      String.raw`\\?\UNC\trusted\share\root\Nested\Entry.js`,
    ],
  ])("returns a case-preserving relative path for %s and %s", (root, source) => {
    const stat = installWindowsPathFixture({ root });
    expect(relativePluginPathInsideRootSync(root, source)).toBe(String.raw`Nested\Entry.js`);
    expect(stat).not.toHaveBeenCalled();
  });
});
