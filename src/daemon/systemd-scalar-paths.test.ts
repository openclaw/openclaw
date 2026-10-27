import fs from "node:fs/promises";
import path from "node:path";
import { Minimatch } from "minimatch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  buildSystemdManagerPropertyOutput,
  buildSystemdUnitPropertyOutput,
  type SystemdManagerSnapshotFixture,
} from "./service.test-helpers.js";
import { nativeExit } from "./systemd-exec.test-support.js";
import {
  readSystemdServiceExecStart,
  resolveSystemdEnvironmentFilePath,
  resolveSystemdUnitPath,
} from "./systemd-service-files.js";
import { buildSystemdUnit, splitSystemdLogicalLines } from "./systemd-unit.js";

const execBusctlUser = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execBusctlUser>());
vi.mock(import("./systemd-exec.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  execBusctlUser,
}));
// Manager responses below are fixtures, independent of the host user-manager transport.
vi.mock("./systemd-user-transport.js", () => ({
  resolveSystemdUserTransport: vi.fn(async () => undefined),
}));

const programArguments = ["/usr/bin/openclaw", "gateway", "run"];

// These are Linux unit contracts using POSIX filenames, including characters Windows cannot create.
describe.skipIf(process.platform === "win32")("systemd scalar paths", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let home: string;
  const serviceEnv = () => ({ HOME: home, OPENCLAW_SYSTEMD_UNIT: "openclaw-scalar-fixture" });
  const unitPath = () => resolveSystemdUnitPath(serviceEnv());

  beforeEach(async () => {
    home = await fs.realpath(tempDirs.make("openclaw-systemd-scalars-"));
    await fs.mkdir(path.dirname(unitPath()), { recursive: true });
    execBusctlUser.mockReset();
    execBusctlUser.mockResolvedValue(nativeExit("", "Synthetic manager unavailable", 1));
  });

  async function writeUnit(content = "[Service]\nExecStart=/usr/bin/openclaw gateway run\n") {
    await fs.writeFile(unitPath(), content, "utf8");
  }

  async function writeEnvironmentFile(filename: string, content = "SELECTED=intended\n") {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content, "utf8");
  }

  async function writeNeighbors(directories: string[], filename: string) {
    const files = directories.map((directory) => path.join(home, directory, filename));
    for (const file of files) {
      await writeEnvironmentFile(file, "FOREIGN=must-not-be-selected\n");
    }
    return files;
  }

  const readCommand = (requireEffective = false) =>
    readSystemdServiceExecStart(serviceEnv(), { requireEffective });

  function mockManager(snapshot: Omit<SystemdManagerSnapshotFixture, "programArguments">) {
    const effective = { programArguments, fragmentPath: unitPath(), ...snapshot };
    const unitProperties = buildSystemdUnitPropertyOutput(effective);
    const serviceProperties = buildSystemdManagerPropertyOutput(effective);
    execBusctlUser.mockImplementation(async (_env, args) => {
      let stdout: string;
      if (args.includes("LoadUnit")) {
        stdout = JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/fixture"] });
      } else if (args.includes("org.freedesktop.systemd1.Unit")) {
        stdout = unitProperties;
      } else if (args.includes("org.freedesktop.systemd1.Service")) {
        stdout = serviceProperties;
      } else {
        throw new Error("Unexpected native request in scalar fixture");
      }
      return nativeExit(stdout);
    });
  }

  function scalarValue(unit: string, directive: string): string {
    const prefix = `${directive}=`;
    const entries = splitSystemdLogicalLines(unit).filter((line) => line.startsWith(prefix));
    expect(entries).toHaveLength(1);
    // Scalar directives do not unquote words. Strip only systemd's surrounding syntax whitespace.
    return entries
      .join("")
      .slice(prefix.length)
      .replace(/^[ \t]+|[ \t]+$/g, "");
  }

  it("rejects trailing whitespace before rendering a different native cwd", () => {
    expect(() =>
      buildSystemdUnit({ programArguments, workingDirectory: `${home}/trailing\t/.//` }),
    ).toThrow("WorkingDirectory cannot end in spaces or tabs");
  });

  it.each([
    { name: "plain", directory: "cwd" },
    { name: "trailing backslash", directory: "cwd\\" },
  ])("renders and reads the complete working directory with $name", async ({ directory }) => {
    const workingDirectory = path.join(home, directory);
    await fs.mkdir(workingDirectory);
    const unit = buildSystemdUnit({
      programArguments,
      workingDirectory,
      environment: { AFTER_CWD: "retained" },
    });
    await writeUnit(unit);

    const encoded = scalarValue(unit, "WorkingDirectory");
    expect(encoded.replaceAll("%%", "")).not.toContain("%");
    const nativePath = encoded.replaceAll("%%", "%");
    expect(nativePath.startsWith(`${home}/`)).toBe(true);
    expect(path.relative(home, nativePath).split(path.sep)).not.toContain("..");
    // Accept equivalent native directory spellings (for example a trailing /.) without prescribing one.
    await expect(fs.realpath(nativePath)).resolves.toBe(workingDirectory);
    const command = await readCommand();
    expect(command?.workingDirectory).toBe(workingDirectory);
    expect(command?.environment).toEqual({ AFTER_CWD: "retained" });
  });

  it("reads an authored working-directory scalar with trailing space", async () => {
    const workingDirectory = path.join(home, "authored ");
    await fs.mkdir(workingDirectory);
    const expression = `${workingDirectory.replaceAll("%", "%%")}/.`;
    await writeUnit(
      `[Service]\nExecStart=/usr/bin/openclaw gateway run\nWorkingDirectory=${expression}\n`,
    );
    const command = await readCommand();
    expect(command?.workingDirectory).toBe(workingDirectory);
  });

  it("keeps percent input literal in argv and inline environment", async () => {
    const literal = path.join(home, 'source %h literal%% "quoted"');
    const argv = [path.join(literal, "openclaw"), "gateway", "--label", "two words"];
    const environment = { OPENCLAW_STATE_DIR: literal };
    await writeUnit(buildSystemdUnit({ programArguments: argv, environment }));

    const command = await readCommand();
    expect(command?.programArguments).toEqual(argv);
    expect(command?.environment).toEqual(environment);
  });

  it.each([
    ["state%h", ["statepercent"]],
    ["state*", ["state-one", "state-two"]],
    ["state\\part", ["statepart", "state/part"]],
  ] satisfies [string, string[]][])(
    "generates a literal EnvironmentFile in %s without selecting neighbors",
    async (directory, alternatives) => {
      const environmentFile = resolveSystemdEnvironmentFilePath({
        stateDir: path.join(home, directory),
      });
      await writeEnvironmentFile(environmentFile);
      const neighboringFiles = await writeNeighbors(alternatives, path.basename(environmentFile));
      const unit = buildSystemdUnit({ programArguments, environmentFiles: [environmentFile] });
      await writeUnit(unit);

      const command = await readCommand();
      expect(command?.environment).toEqual({ SELECTED: "intended" });
      expect(command?.environmentValueSources).toEqual({ SELECTED: "file" });
      const encoded = scalarValue(unit, "EnvironmentFile");
      expect(encoded.startsWith("-/")).toBe(true);
      expect(encoded.replaceAll("%%", "")).not.toContain("%");
      // Independently check native-compatible literal selection, allowing either glob escape spelling.
      const matcher = new Minimatch(encoded.slice(1).replaceAll("%%", "%"), {
        nobrace: true,
        noext: true,
        platform: "linux",
        optimizationLevel: 0,
      });
      expect(matcher.match(environmentFile)).toBe(true);
      for (const neighbor of neighboringFiles) {
        expect(matcher.match(neighbor)).toBe(false);
      }
    },
  );

  it("preserves an escaped question mark alongside a real manager wildcard", async () => {
    await writeEnvironmentFile(
      path.join(home, "state?", "set-10.env"),
      "FIRST=retained\nSHARED=first\n",
    );
    await writeEnvironmentFile(path.join(home, "state?", "set-20.env"), "SHARED=second\n");
    await writeNeighbors(["state1", "state2"], "set-10.env");
    await writeUnit();
    mockManager({ environmentFiles: [[path.join(home, "state\\?", "set-*.env"), false]] });
    const command = await readCommand(true);
    expect(command?.environment).toEqual({ FIRST: "retained", SHARED: "second" });
    expect(command?.environmentValueSources).toEqual({ FIRST: "file", SHARED: "file" });
  });

  it.each([false, true])(
    "does not broaden a missing literal file (optional=%s)",
    async (optional) => {
      await writeNeighbors(["missing-one"], "gateway.systemd.env");
      const expression = path.join(home, "missing\\*", "gateway.systemd.env");
      await writeUnit(
        "[Service]\nExecStart=/usr/bin/openclaw gateway run\nEnvironment=INLINE=retained\n",
      );
      mockManager({
        environment: ["INLINE=retained"],
        environmentFiles: [[expression, optional]],
      });
      const command = readCommand(true);
      if (!optional) {
        await expect(command).rejects.toThrow();
      } else {
        expect((await command)?.environment).toEqual({ INLINE: "retained" });
      }
    },
  );
  it.each([false, true])(
    "does not read an optional relative EnvironmentFile (manager=%s)",
    async (manager) => {
      const relativeFile = path.join(path.dirname(unitPath()), "operator.env");
      await writeEnvironmentFile(relativeFile, "FOREIGN=must-not-be-read\n");
      const unit =
        "[Service]\nExecStart=/usr/bin/openclaw gateway run\n" +
        (manager ? "" : "Environment=INLINE=retained\nEnvironmentFile=-./operator.env\n");
      await writeUnit(unit);
      if (manager) {
        mockManager({ environmentFiles: [["operator.env", true]] });
      }
      const readFile = vi.spyOn(fs, "readFile");
      try {
        if (manager) {
          await expect(readCommand(true)).rejects.toThrow();
        } else {
          expect((await readCommand())?.environment).toEqual({ INLINE: "retained" });
        }
        expect(readFile).not.toHaveBeenCalledWith(relativeFile, "utf8");
        await expect(fs.readFile(unitPath(), "utf8")).resolves.toBe(unit);
      } finally {
        readFile.mockRestore();
      }
    },
  );

  it("records only the keys supplied by an authored space-containing EnvironmentFile drop-in", async () => {
    const environmentFile = path.join(home, "operator space", "operator.env");
    await writeEnvironmentFile(environmentFile);
    const dropIn = path.join(`${unitPath()}.d`, "10-operator.conf");
    await fs.mkdir(path.dirname(dropIn), { recursive: true });
    await fs.writeFile(dropIn, `[Service]\nEnvironmentFile=${environmentFile}\n`, "utf8");
    await writeUnit();
    mockManager({ environmentFiles: [[environmentFile, false]], dropInPaths: [dropIn] });

    const command = await readCommand(true);
    expect(command?.environment).toEqual({ SELECTED: "intended" });
    expect(command?.managedOverrides).toEqual({ environment: { keys: ["SELECTED"] } });
  });
});
