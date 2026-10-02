import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as systemctl from "../daemon/systemd-exec.js";
import * as systemd from "../daemon/systemd-service-files.js";
import type { ImmutableInstallDescriptor } from "./update-immutable-install-schema.js";
import { verifyImmutableService } from "./update-immutable-service.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let generation: string;
let node: string;
let service: ImmutableInstallDescriptor["service"];

beforeEach(async () => {
  const home = dirs.make("immutable-service-");
  root = path.join(home, "install");
  generation = path.join(root, "releases", "a".repeat(40));
  node = path.join(home, "node");
  await fs.mkdir(path.join(generation, "dist"), { recursive: true });
  await fs.writeFile(path.join(generation, "dist", "index.js"), "");
  await fs.writeFile(node, "");
  await fs.symlink(generation, path.join(root, "current"));
  service = {
    unit: "example.service",
    scope: "system",
    account: "openclaw",
    stateDir: "/var/lib/example",
    configPath: "/etc/example/openclaw.json",
    profile: null,
  };
  const command = {
    programArguments: [node, path.join(root, "current", "dist", "index.js"), "gateway"],
    sourcePath: "/etc/systemd/system/example.service",
    environment: {
      OPENCLAW_STATE_DIR: service.stateDir,
      OPENCLAW_CONFIG_PATH: service.configPath,
    },
  };
  vi.spyOn(systemd, "readSystemdServiceCommandLocation").mockResolvedValue({
    kind: "command",
    command,
  });
  vi.spyOn(systemd, "readSystemdServiceExecStartAsRoot").mockResolvedValue(command);
  vi.spyOn(systemctl, "execSystemctl").mockResolvedValue({
    code: 0,
    termination: "exit",
    stdout:
      "Id=example.service\nLoadState=loaded\nActiveState=active\nDynamicUser=no\nRootDirectory=\nRootImage=\n",
    stderr: "",
  });
});
afterEach(() => vi.restoreAllMocks());

it("binds the effective service to the physical current generation and explicit state", async () => {
  await expect(verifyImmutableService(service, root, generation, node)).resolves.toBeUndefined();
  expect(systemd.readSystemdServiceExecStartAsRoot).toHaveBeenCalledWith(
    { OPENCLAW_SYSTEMD_UNIT: "example.service" },
    {
      scope: "system",
      unitName: "example.service",
      unitPath: "/etc/systemd/system/example.service",
    },
    "openclaw",
  );
});

it.each(["stateDir", "configPath", "profile"] as const)(
  "refuses adoption when the supplied %s does not match the effective service",
  async (key) => {
    service[key] = key === "profile" ? "other" : "/unrelated";
    await expect(verifyImmutableService(service, root, generation, node)).rejects.toThrow(
      "effective environment",
    );
  },
);

it("refuses a current symlink redirected to another generation", async () => {
  const other = path.join(root, "releases", "b".repeat(40));
  await fs.mkdir(path.join(other, "dist"), { recursive: true });
  await fs.writeFile(path.join(other, "dist", "index.js"), "");
  await fs.unlink(path.join(root, "current"));
  await fs.symlink(other, path.join(root, "current"));
  await expect(verifyImmutableService(service, root, generation, node)).rejects.toThrow(
    "current immutable generation",
  );
});
