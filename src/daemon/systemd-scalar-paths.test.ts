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
import {
  readSystemdServiceExecStart,
  resolveSystemdEnvironmentFilePath as envFilePath,
  resolveSystemdUnitPath,
} from "./systemd-service-files.js";
import { buildSystemdUnit, splitSystemdLogicalLines } from "./systemd-unit.js";

const execBusctlUser = vi.hoisted(() => vi.fn<typeof import("./systemd-exec.js").execBusctlUser>());
vi.mock(import("./systemd-exec.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  execBusctlUser,
}));
vi.mock("./systemd-user-transport.js", () => ({
  resolveSystemdUserTransport: vi.fn(async () => undefined),
}));

const programArguments = ["/usr/bin/openclaw", "gateway", "run"];
const literalDirectories = [
  ["percent", "state%h", ["statepercent"]],
  ["asterisk", "state*", ["state-one", "state-two"]],
  ["backslash", "state\\part", ["statepart", "state/part"]],
] satisfies [string, string, string[]][];
const foreign = "FOREIGN=must-not-be-selected\n";

// These are Linux unit contracts using POSIX filenames, including characters Windows cannot create.
describe.skipIf(process.platform === "win32")("systemd scalar paths", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let home: string;
  const serviceEnv = () => ({ HOME: home, OPENCLAW_SYSTEMD_UNIT: "openclaw-scalar-fixture" });
  const unitPath = () => resolveSystemdUnitPath(serviceEnv());
  const readCommand = (options?: Parameters<typeof readSystemdServiceExecStart>[1]) =>
    readSystemdServiceExecStart(serviceEnv(), options);
  const baseUnit = "[Service]\nExecStart=/usr/bin/openclaw gateway run\n";

  beforeEach(async () => {
    home = await fs.realpath(tempDirs.make("openclaw-systemd-scalars-"));
    await fs.mkdir(path.dirname(unitPath()), { recursive: true });
    execBusctlUser.mockReset();
    execBusctlUser.mockResolvedValue({
      code: 1,
      termination: "exit",
      stdout: "",
      stderr: "Synthetic manager unavailable",
    });
  });

  const writeUnit = (content = baseUnit) => fs.writeFile(unitPath(), content, "utf8");

  async function writeEnvironmentFile(filename: string, content = "SELECTED=intended\n") {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content, "utf8");
  }
  const writeForeignFiles = (filenames: string[]) =>
    Promise.all(filenames.map((filename) => writeEnvironmentFile(filename, foreign)));

  function mockManager(snapshot: Omit<SystemdManagerSnapshotFixture, "programArguments">) {
    const effective = { programArguments, fragmentPath: unitPath(), ...snapshot };
    const replies: Record<string, string> = {
      LoadUnit: JSON.stringify({ type: "o", data: ["/org/freedesktop/systemd1/unit/fixture"] }),
      "org.freedesktop.systemd1.Unit": buildSystemdUnitPropertyOutput(effective),
      "org.freedesktop.systemd1.Service": buildSystemdManagerPropertyOutput(effective),
    };
    execBusctlUser.mockImplementation(async (_env, args) => {
      const request = Object.keys(replies).find((key) => args.includes(key));
      if (!request) {
        throw new Error("Unexpected native request in scalar fixture");
      }
      return { code: 0, termination: "exit", stdout: replies[request], stderr: "" };
    });
  }

  function scalarValue(unit: string, directive: string): string {
    const prefix = `${directive}=`;
    const entries = splitSystemdLogicalLines(unit).filter((line) => line.startsWith(prefix));
    expect(entries).toHaveLength(1);
    return entries
      .join("")
      .slice(prefix.length)
      .replace(/^[ \t]+|[ \t]+$/g, "");
  }

  it("rejects lossy working-directory spelling", () => {
    expect(() =>
      buildSystemdUnit({ programArguments, workingDirectory: `${home}/trailing\t/.//` }),
    ).toThrow("WorkingDirectory cannot end in spaces or tabs");
  });

  it.each(["cwd", "cwd\\"])("round-trips working directory %j", async (directory) => {
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
    await expect(fs.realpath(nativePath)).resolves.toBe(workingDirectory);
    const command = await readCommand();
    expect(command?.workingDirectory).toBe(workingDirectory);
    expect(command?.environment).toEqual({ AFTER_CWD: "retained" });
  });

  it("reads authored working-directory trailing space", async () => {
    const workingDirectory = path.join(home, "authored ");
    await fs.mkdir(workingDirectory);
    await writeUnit(`${baseUnit}WorkingDirectory=${workingDirectory.replaceAll("%", "%%")}/.\n`);
    expect((await readCommand())?.workingDirectory).toBe(workingDirectory);
  });

  it.each(["argv", "inline"] as const)("keeps %s percent literal", async (surface) => {
    const literal = path.join(home, 'source %h literal%% "quoted"');
    const argv =
      surface === "argv"
        ? [path.join(literal, "openclaw"), "gateway", "--label", "two words"]
        : programArguments;
    const environment = surface === "inline" ? { OPENCLAW_STATE_DIR: literal } : {};
    await writeUnit(buildSystemdUnit({ programArguments: argv, environment }));

    const command = await readCommand();
    expect(command?.programArguments).toEqual(argv);
    if (surface === "inline") {
      expect(command?.environment).toEqual(environment);
    }
  });

  it.each(literalDirectories)(
    "selects literal EnvironmentFile: %s",
    async (_name, directory, alternatives) => {
      const environmentFile = envFilePath({ stateDir: path.join(home, directory) });
      await writeEnvironmentFile(environmentFile);
      const neighboringFiles = alternatives.map((dir) =>
        envFilePath({ stateDir: path.join(home, dir) }),
      );
      await writeForeignFiles(neighboringFiles);
      const unit = buildSystemdUnit({ programArguments, environmentFiles: [environmentFile] });
      await writeUnit(unit);

      const command = await readCommand();
      expect(command?.environment).toEqual({ SELECTED: "intended" });
      expect(command?.environmentValueSources).toEqual({ SELECTED: "file" });
      const encoded = scalarValue(unit, "EnvironmentFile");
      expect(encoded.startsWith("-/")).toBe(true);
      expect(encoded.replaceAll("%%", "")).not.toContain("%");
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

  it("preserves escaped question marks alongside a wildcard", async () => {
    const directory = "state?";
    const alternatives = ["state1", "state2"];
    await writeEnvironmentFile(
      path.join(home, directory, "set-10.env"),
      "FIRST=retained\nSHARED=first\n",
    );
    await writeEnvironmentFile(path.join(home, directory, "set-20.env"), "SHARED=second\n");
    await writeForeignFiles(alternatives.map((dir) => path.join(home, dir, "set-10.env")));
    await writeUnit();
    mockManager({ environmentFiles: [[path.join(home, "state\\?", "set-*.env"), false]] });
    const command = await readCommand({ requireEffective: true });
    expect(command?.environment).toEqual({ FIRST: "retained", SHARED: "second" });
    expect(command?.environmentValueSources).toEqual({ FIRST: "file", SHARED: "file" });
  });

  it.each([false, true])("keeps missing files literal: optional=%s", async (optional) => {
    await writeForeignFiles([path.join(home, "missing-one", "gateway.systemd.env")]);
    const expression = path.join(home, "missing\\*", "gateway.systemd.env");
    await writeUnit(`${baseUnit}Environment=INLINE=retained\n`);
    mockManager({
      environment: ["INLINE=retained"],
      environmentFiles: [[expression, optional]],
    });
    const command = readCommand({ requireEffective: true });
    if (!optional) {
      await expect(command).rejects.toThrow();
    } else {
      expect((await command)?.environment).toEqual({ INLINE: "retained" });
    }
  });
  it.each([false, true])("guards relative EnvironmentFiles (manager=%s)", async (manager) => {
    const relativeFile = path.join(path.dirname(unitPath()), "operator.env");
    await writeForeignFiles([relativeFile]);
    const unit = manager
      ? baseUnit
      : `${baseUnit}Environment=INLINE=retained\nEnvironmentFile=-./operator.env\n`;
    await writeUnit(unit);
    if (manager) {
      mockManager({ environmentFiles: [["operator.env", true]] });
    }
    const readFile = vi.spyOn(fs, "readFile");
    try {
      if (manager) {
        await expect(readCommand({ requireEffective: true })).rejects.toThrow();
      } else {
        expect((await readCommand())?.environment).toEqual({ INLINE: "retained" });
      }
      expect(readFile).not.toHaveBeenCalledWith(relativeFile, "utf8");
      await expect(fs.readFile(unitPath(), "utf8")).resolves.toBe(unit);
    } finally {
      readFile.mockRestore();
    }
  });

  it("records keys from space-containing EnvironmentFile drop-ins", async () => {
    const environmentFile = path.join(home, "operator space", "operator.env");
    await writeEnvironmentFile(environmentFile);
    const dropIn = path.join(`${unitPath()}.d`, "10-operator.conf");
    await writeEnvironmentFile(dropIn, `[Service]\nEnvironmentFile=${environmentFile}\n`);
    await writeUnit();
    mockManager({ environmentFiles: [[environmentFile, false]], dropInPaths: [dropIn] });

    const command = await readCommand({ requireEffective: true });
    expect(command?.environment).toEqual({ SELECTED: "intended" });
    expect(command?.managedOverrides).toEqual({ environment: { keys: ["SELECTED"] } });
  });
});
