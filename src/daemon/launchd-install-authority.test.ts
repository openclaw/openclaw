import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { installLaunchAgent } from "./launchd-install.js";
import {
  resolveLaunchAgentEnvironmentReadOptions,
  resolveLaunchAgentEnvWrapperPath,
  resolveLaunchAgentPlistPath,
} from "./launchd-service-files.js";
import {
  assertGatewayServiceUpdateCurrent,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";

const native = vi.hoisted(() => ({
  command: vi.fn<typeof import("../process/exec.js").runCommandWithTimeout>(),
  ownership: vi.fn<typeof import("./launchd-system.js").assertNoSystemLaunchDaemonOwnership>(),
}));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: native.command,
}));
// mock-isolation: Exercise ownership revocation without reading host LaunchDaemons.
vi.mock("./launchd-system.js", () => ({ assertNoSystemLaunchDaemonOwnership: native.ownership }));
vi.mock("./launchd-current-service.js", () => ({
  isCurrentProcessInsideLaunchdService: async () => false,
}));

const temporary = useAutoCleanupTempDirTracker(afterEach);
const checkCurrent = async () => {
  assertGatewayServiceUpdateCurrent();
};
const rejectTask = async () => {
  throw new Error("Unexpected task publication");
};
const definitionTransaction = {
  assertCurrent: assertGatewayServiceUpdateCurrent,
  beforeWrite: checkCurrent,
  filePrepared: checkCurrent,
  fileWritten: checkCurrent,
  taskPrepared: rejectTask,
  taskWritten: rejectTask,
};

beforeEach(() => {
  native.command.mockReset();
  native.ownership.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

const activation = ["bootout", "enable", "bootstrap"];
const recovery = ["bootout", "enable", "bootstrap"];
it.each<[string, boolean, string | null | undefined, string[], number]>([
  ["snapshot-read", false, "unchanged", [], 0],
  ["before-write", false, "unchanged", [], 0],
  ["before-publication", false, "unchanged", [], 0],
  ["environment-published", false, "restored", [], 0],
  ["plist-published", false, "restored", [], 0],
  ["publication-error", false, null, [], 0],
  ["bootout", false, "restored", recovery, 1],
  ["bootstrap", false, "restored", [...activation, ...recovery], 2],
  ["plist-published", true, undefined, [], 0],
  ["bootstrap", true, undefined, activation, 0],
  ["competing-writer", false, "recovery-pending", [], 0],
])("retains %s (transaction=%s)", async (boundary, transaction, outcome, actions, restores) => {
  const root = temporary.make("launchd-install-authority-");
  const env = {
    HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.install-authority",
  };
  const label = env.OPENCLAW_LAUNCHD_LABEL;
  const plist = resolveLaunchAgentPlistPath(env);
  const { expectedEnvironmentFilePath: environment } = resolveLaunchAgentEnvironmentReadOptions(
    env,
    label,
  );
  const wrapper = resolveLaunchAgentEnvWrapperPath(env, label);
  const previousPlist = "previous plist\n";
  const originals = [
    [plist, previousPlist, 0o644],
    [environment, "export OPERATOR='original'\n", 0o600],
    [wrapper, "#!/bin/sh\nexec old-gateway\n", 0o700],
  ] as const;
  for (const [file, contents, mode] of originals) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, contents, { mode });
  }
  const args = {
    env,
    stdout: new PassThrough(),
    programArguments: [process.execPath, "/candidate/openclaw/dist/index.js", "gateway"],
    environment: { OPENCLAW_GATEWAY_PORT: "19871" },
  };
  let current = true;
  let loaded = true;
  const activations: string[] = [];
  const bootstrapDefinitions: string[] = [];
  native.command.mockImplementation(async ([binary, nativeAction, target]) => {
    const action = expectDefined(nativeAction, "Expected a native launchctl action");
    expect(binary).toBe("launchctl");
    if (action === "bootout" || action === "unload") {
      loaded = false;
    }
    if (action === "bootstrap") {
      loaded = true;
      bootstrapDefinitions.push(await fs.readFile(plist, "utf8"));
    }
    if (action !== "print") {
      activations.push(action);
    }
    if (action === boundary || (boundary === "snapshot-read" && action === "print")) {
      current = false;
    }
    return createCommandResult({
      code: action === "print" && !loaded ? 1 : 0,
      stdout: action === "print" && loaded ? `${target} = {\n\tstate = waiting\n}` : "",
      stderr: action === "print" && !loaded ? "Could not find service" : "",
    });
  });
  if (boundary === "before-write") {
    native.ownership.mockImplementationOnce(async () => {
      current = false;
    });
  }
  const write = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementation(async (...parameters) => {
    await write(...parameters);
    if (boundary === "before-publication") {
      current = false;
    }
  });
  const rename = fs.rename;
  const publications: string[] = [];
  let failedPublication = false;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    publications.push(String(to));
    if (boundary === "publication-error" && to === plist && !failedPublication) {
      failedPublication = true;
      throw new Error("publication confirmation failed after rename");
    }
    if (
      (boundary === "environment-published" && to === environment) ||
      (["plist-published", "competing-writer"].includes(boundary) && to === plist)
    ) {
      if (boundary === "competing-writer") {
        await fs.writeFile(environment, "external replacement\n");
      }
      current = false;
    }
  });

  const result = withGatewayServiceUpdateAuthority(
    () => {
      if (!current) {
        throw new Error("Maintenance custody released");
      }
    },
    () => installLaunchAgent({ ...args, ...(transaction ? { definitionTransaction } : {}) }),
    { updateOwned: false, assertRecoveryCurrent: () => {} },
  );
  if (boundary === "publication-error") {
    await expect(result).rejects.toThrow("publication confirmation failed after rename");
  } else {
    await expect(result).rejects.toMatchObject({ code: "service-authority-revoked", outcome });
  }
  expect({ activations, loaded }).toEqual({ activations: actions, loaded: true });
  if (transaction || boundary === "competing-writer") {
    expect(await fs.readFile(plist, "utf8")).toContain("/candidate/openclaw/dist/index.js");
    if (!transaction) {
      expect(await fs.readFile(environment, "utf8")).toBe("external replacement\n");
      expect(native.command.mock.calls.every(([argv]) => argv[1] === "print")).toBe(true);
    }
    return;
  }
  for (const [file, contents, mode] of originals) {
    expect(await fs.readFile(file, "utf8")).toBe(contents);
    expect((await fs.stat(file)).mode & 0o777).toBe(mode);
  }
  if (boundary.startsWith("before-") || boundary === "snapshot-read") {
    expect(publications).toEqual([]);
  }
  if (restores) {
    expect(bootstrapDefinitions.at(-1)).toBe(previousPlist);
    expect(bootstrapDefinitions).toHaveLength(restores);
  }
  for (const directory of new Set(originals.map(([file]) => path.dirname(file)))) {
    expect((await fs.readdir(directory)).some((file) => file.endsWith(".tmp"))).toBe(false);
  }
});
