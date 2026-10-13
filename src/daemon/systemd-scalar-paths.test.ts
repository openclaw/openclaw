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
const literalDirectories = [
  { name: "percent", directory: "state%h", expression: "state%h", alternatives: ["statepercent"] },
  {
    name: "asterisk",
    directory: "state*",
    expression: "state\\*",
    alternatives: ["state-one", "state-two"],
  },
  {
    name: "question mark",
    directory: "state?",
    expression: "state\\?",
    alternatives: ["state1", "state2"],
  },
  {
    name: "backslash",
    directory: "state\\part",
    expression: "state\\\\part",
    alternatives: ["statepart", "state/part"],
  },
];

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
    execBusctlUser.mockResolvedValue({
      code: 1,
      termination: "exit",
      stdout: "",
      stderr: "Synthetic manager unavailable",
    });
  });

  async function writeUnit(content = "[Service]\nExecStart=/usr/bin/openclaw gateway run\n") {
    await fs.writeFile(unitPath(), content, "utf8");
  }

  async function writeEnvironmentFile(filename: string, content = "SELECTED=intended\n") {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(filename, content, "utf8");
  }

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
      return { code: 0, termination: "exit", stdout, stderr: "" };
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

  async function readExpression(expression: string) {
    await writeUnit();
    mockManager({ environmentFiles: [[expression, false]] });
    return readSystemdServiceExecStart(serviceEnv(), { requireEffective: true });
  }

  it.each(["trailing\t/.//"])(
    "rejects working-directory spelling %j before rendering a different native cwd",
    (directory) => {
      expect(() =>
        buildSystemdUnit({ programArguments, workingDirectory: `${home}/${directory}` }),
      ).toThrow("WorkingDirectory cannot end in spaces or tabs");
    },
  );

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
    const command = await readSystemdServiceExecStart(serviceEnv());
    expect(command?.workingDirectory).toBe(workingDirectory);
    expect(command?.environment).toEqual({ AFTER_CWD: "retained" });
  });

  it.each([{ name: "trailing space", directory: "authored ", suffix: "/." }])(
    "reads an authored working-directory scalar with $name",
    async ({ directory, suffix }) => {
      const workingDirectory = path.join(home, directory);
      await fs.mkdir(workingDirectory);
      const expression = `${workingDirectory.replaceAll("%", "%%")}${suffix}`;
      await writeUnit(
        `[Service]\nExecStart=/usr/bin/openclaw gateway run\nWorkingDirectory=${expression}\n`,
      );

      const command = await readSystemdServiceExecStart(serviceEnv());
      expect(command?.workingDirectory).toBe(workingDirectory);
    },
  );

  it.each(["argv", "inline environment"] as const)(
    "keeps builder percent input literal in %s while retaining word quoting",
    async (surface) => {
      const literal = path.join(home, 'source %h literal%% "quoted"');
      const argv =
        surface === "argv"
          ? [path.join(literal, "openclaw"), "gateway", "--label", "two words"]
          : programArguments;
      const environment = surface === "inline environment" ? { OPENCLAW_STATE_DIR: literal } : {};
      await writeUnit(buildSystemdUnit({ programArguments: argv, environment }));

      const command = await readSystemdServiceExecStart(serviceEnv());
      expect(command?.programArguments).toEqual(argv);
      if (surface === "inline environment") {
        expect(command?.environment).toEqual(environment);
      }
    },
  );

  it.each(literalDirectories.filter(({ name }) => name !== "question mark"))(
    "generates a literal EnvironmentFile with $name without selecting neighboring files",
    async ({ directory, alternatives }) => {
      const environmentFile = resolveSystemdEnvironmentFilePath({
        stateDir: path.join(home, directory),
      });
      await writeEnvironmentFile(environmentFile);
      const neighboringFiles = alternatives.map((alternative) =>
        resolveSystemdEnvironmentFilePath({ stateDir: path.join(home, alternative) }),
      );
      for (const neighbor of neighboringFiles) {
        await writeEnvironmentFile(neighbor, "FOREIGN=must-not-be-selected\n");
      }
      const unit = buildSystemdUnit({ programArguments, environmentFiles: [environmentFile] });
      await writeUnit(unit);

      const command = await readSystemdServiceExecStart(serviceEnv());
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

  describe("manager EnvironmentFile expressions", () => {
    it.each(literalDirectories.filter(({ name }) => name === "question mark"))(
      "preserves escaped $name alongside a real wildcard",
      async ({ directory, expression, alternatives }) => {
        await writeEnvironmentFile(
          path.join(home, directory, "set-10.env"),
          "FIRST=retained\nSHARED=first\n",
        );
        await writeEnvironmentFile(path.join(home, directory, "set-20.env"), "SHARED=second\n");
        for (const alternative of alternatives) {
          await writeEnvironmentFile(
            path.join(home, alternative, "set-10.env"),
            "FOREIGN=must-not-be-selected\n",
          );
        }
        const command = await readExpression(path.join(home, expression, "set-*.env"));
        expect(command?.environment).toEqual({ FIRST: "retained", SHARED: "second" });
        expect(command?.environmentValueSources).toEqual({ FIRST: "file", SHARED: "file" });
      },
    );

    it.each([false, true])(
      "does not broaden a missing literal file (optional=%s)",
      async (optional) => {
        await writeEnvironmentFile(
          path.join(home, "missing-one", "gateway.systemd.env"),
          "FOREIGN=must-not-be-selected\n",
        );
        const expression = path.join(home, "missing\\*", "gateway.systemd.env");
        await writeUnit(
          "[Service]\nExecStart=/usr/bin/openclaw gateway run\nEnvironment=INLINE=retained\n",
        );
        mockManager({
          environment: ["INLINE=retained"],
          environmentFiles: [[expression, optional]],
        });
        const command = readSystemdServiceExecStart(serviceEnv(), {
          requireEffective: true,
        });
        if (!optional) {
          await expect(command).rejects.toThrow();
        } else {
          expect((await command)?.environment).toEqual({ INLINE: "retained" });
        }
      },
    );
  });

  it.each([true])(
    "does not read an authored relative EnvironmentFile (optional=%s)",
    async (optional) => {
      const relativeFile = path.join(path.dirname(unitPath()), "operator.env");
      await writeEnvironmentFile(relativeFile, "FOREIGN=must-not-be-read\n");
      const unit = `[Service]\nExecStart=/usr/bin/openclaw gateway run\nEnvironment=INLINE=retained\nEnvironmentFile=${optional ? "-" : ""}./operator.env\n`;
      await writeUnit(unit);
      const readFile = vi.spyOn(fs, "readFile");
      try {
        const command = await readSystemdServiceExecStart(serviceEnv());
        expect(readFile).not.toHaveBeenCalledWith(relativeFile, "utf8");
        expect(command?.environment).toEqual({ INLINE: "retained" });
        await expect(fs.readFile(unitPath(), "utf8")).resolves.toBe(unit);
      } finally {
        readFile.mockRestore();
      }
    },
  );

  it.each([true])(
    "rejects a relative manager EnvironmentFile tuple (optional=%s)",
    async (optional) => {
      const relativeFile = path.join(path.dirname(unitPath()), "operator.env");
      await writeEnvironmentFile(relativeFile, "FOREIGN=must-not-be-read\n");
      const unit = "[Service]\nExecStart=/usr/bin/openclaw gateway run\n";
      await writeUnit(unit);
      mockManager({ environmentFiles: [["operator.env", optional]] });
      const readFile = vi.spyOn(fs, "readFile");
      try {
        await expect(
          readSystemdServiceExecStart(serviceEnv(), { requireEffective: true }),
        ).rejects.toThrow();
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

    const command = await readSystemdServiceExecStart(serviceEnv(), { requireEffective: true });
    expect(command?.environment).toEqual({ SELECTED: "intended" });
    expect(command?.managedOverrides).toEqual({ environment: { keys: ["SELECTED"] } });
  });
});
