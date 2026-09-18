import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { installLaunchAgent } from "./launchd-install.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import {
  resolveLaunchAgentEnvFilePath,
  resolveLaunchAgentEnvWrapperPath,
  resolveLaunchAgentPlistPath,
} from "./launchd-service-files.js";
import { withGatewayServiceUpdateAuthority } from "./service-update-authority.js";

const native = vi.hoisted(() => ({
  command: vi.fn<typeof import("../process/exec.js").runCommandWithTimeout>(),
  ownership: vi.fn<typeof import("./launchd-system.js").assertNoSystemLaunchDaemonOwnership>(),
}));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: native.command,
}));
vi.mock("./launchd-system.js", () => ({
  assertNoSystemLaunchDaemonOwnership: native.ownership,
}));
vi.mock("./launchd-current-service.js", () => ({
  isCurrentProcessInsideLaunchdService: async () => false,
}));

const temporary = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  native.command.mockReset();
  native.ownership.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = temporary.make("launchd-install-authority-");
  const env = {
    HOME: root,
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_LAUNCHD_LABEL: "ai.openclaw.install-authority",
  };
  const label = resolveLaunchAgentLabel(env);
  const plist = resolveLaunchAgentPlistPath(env);
  const environment = resolveLaunchAgentEnvFilePath(env, label);
  const wrapper = resolveLaunchAgentEnvWrapperPath(env, label);
  const originals = new Map([
    [plist, { contents: "previous plist\n", mode: 0o644 }],
    [environment, { contents: "export OPERATOR='original'\n", mode: 0o600 }],
    [wrapper, { contents: "#!/bin/sh\nexec old-gateway\n", mode: 0o700 }],
  ]);
  for (const [file, original] of originals) {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(file, original.contents, { mode: original.mode });
  }
  return {
    originals,
    plist,
    environment,
    args: {
      env,
      stdout: new PassThrough(),
      programArguments: [process.execPath, "/candidate/openclaw/dist/index.js", "gateway"],
      environment: { OPENCLAW_GATEWAY_PORT: "19871" },
    },
  };
}

it.each([
  "snapshot-read",
  "before-write",
  "before-publication",
  "environment-published",
  "plist-published",
  "bootout",
  "bootstrap",
] as const)("restores owned LaunchAgent effects when custody ends at %s", async (boundary) => {
  const { args, originals, plist, environment } = await fixture();
  let current = true;
  let loaded = true;
  const activations: string[] = [];
  const bootstrapDefinitions: string[] = [];
  native.command.mockImplementation(async ([binary, nativeAction]) => {
    const action = expectDefined(nativeAction);
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
    return {
      code: action === "print" && !loaded ? 1 : 0,
      stdout: action === "print" && loaded ? "state = waiting\n" : "",
      stderr: action === "print" && !loaded ? "Could not find service" : "",
      signal: null,
      killed: false,
      termination: "exit",
    };
  });
  if (boundary === "before-write") {
    native.ownership.mockImplementationOnce(async () => {
      current = false;
    });
  }
  const write = fs.writeFile;
  vi.spyOn(fs, "writeFile").mockImplementation(async (...parameters) => {
    await write(...parameters);
    if (boundary === "before-publication" && String(parameters[0]).endsWith(".tmp")) {
      current = false;
    }
  });
  const rename = fs.rename;
  const publications: string[] = [];
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    publications.push(String(to));
    if (
      (boundary === "environment-published" && to === environment) ||
      (boundary === "plist-published" && to === plist)
    ) {
      current = false;
    }
  });

  await expect(
    withGatewayServiceUpdateAuthority(
      () => {
        if (!current) {
          throw new Error("Doctor maintenance custody released");
        }
      },
      () => installLaunchAgent(args),
      { updateOwned: false, assertRecoveryCurrent: () => {} },
    ),
  ).rejects.toMatchObject({
    code: "service-authority-revoked",
    outcome:
      boundary.startsWith("before-") || boundary === "snapshot-read" ? "unchanged" : "restored",
  });
  for (const [file, original] of originals) {
    expect(await fs.readFile(file, "utf8")).toBe(original.contents);
    expect((await fs.stat(file)).mode & 0o777).toBe(original.mode);
  }
  expect(loaded).toBe(true);
  if (boundary.startsWith("before-") || boundary === "snapshot-read") {
    expect(publications).toEqual([]);
  }
  if (boundary === "bootout" || boundary === "bootstrap") {
    expect(bootstrapDefinitions.at(-1)).toBe(originals.get(plist)!.contents);
    expect(bootstrapDefinitions).toHaveLength(boundary === "bootstrap" ? 2 : 1);
    expect(activations).toEqual(
      boundary === "bootout"
        ? ["bootout", "enable", "bootstrap"]
        : ["bootout", "unload", "enable", "bootstrap", "bootout", "enable", "bootstrap"],
    );
  } else {
    expect(activations).toEqual([]);
  }
  for (const directory of new Set([...originals.keys()].map((file) => path.dirname(file)))) {
    expect((await fs.readdir(directory)).some((file) => file.endsWith(".tmp"))).toBe(false);
  }
});

it("retains another writer's artifact instead of claiming successful LaunchAgent recovery", async () => {
  const { args, plist, environment } = await fixture();
  let current = true;
  native.command.mockResolvedValue({
    code: 0,
    stdout: "state = waiting\n",
    stderr: "",
    signal: null,
    killed: false,
    termination: "exit",
  });
  const rename = fs.rename;
  vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    if (to === plist) {
      await fs.writeFile(environment, "external replacement\n");
      current = false;
    }
  });
  await expect(
    withGatewayServiceUpdateAuthority(
      () => {
        if (!current) {
          throw new Error("Competing update admitted");
        }
      },
      () => installLaunchAgent(args),
      { updateOwned: false, assertRecoveryCurrent: () => {} },
    ),
  ).rejects.toMatchObject({ code: "service-authority-revoked", outcome: "recovery-pending" });
  expect(await fs.readFile(environment, "utf8")).toBe("external replacement\n");
  expect(await fs.readFile(plist, "utf8")).toContain("/candidate/openclaw/dist/index.js");
  expect(native.command.mock.calls.every(([argv]) => argv[1] === "print")).toBe(true);
});
