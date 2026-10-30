import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveLiveManagedGatewayDistFence } from "../../scripts/lib/live-gateway-dist-fence.mts";
import * as inventory from "../../src/daemon/inspect.js";
import * as launchdExec from "../../src/daemon/launchd-exec.js";
import { withMockedPlatform } from "../../src/test-utils/vitest-spies.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it.each([
  { defaultState: "absent", overlap: false, refuse: false },
  { defaultState: "unreadable", overlap: false, refuse: true },
  { defaultState: "absent", overlap: true, refuse: true },
])(
  "checks native absence before building: default=$defaultState siblingOverlap=$overlap",
  async ({ defaultState, overlap, refuse }) => {
    const directory = tempDirs.make("openclaw-fence-native-absence-");
    const checkout = path.join(directory, "checkout");
    const other = path.join(directory, "other");
    const home = path.join(directory, "home");
    for (const root of [checkout, other]) {
      await fs.mkdir(path.join(root, "dist"), { recursive: true });
      await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw"}\n');
      await fs.writeFile(path.join(root, "dist", "index.js"), "// synthetic Gateway\n");
    }
    const label = "org.example.fence-sibling";
    const plist = path.join(home, "Library", "LaunchAgents", `${label}.plist`);
    vi.spyOn(inventory, "listManagedOpenClawGatewayServices").mockResolvedValue({
      services: [
        { platform: "darwin", scope: "user", label, detail: `plist: ${plist}`, sourcePath: plist },
      ],
      errors: [],
    });
    const native = vi.spyOn(launchdExec, "execLaunchctl").mockImplementation(async (args) => {
      const target = args[1] ?? "";
      if (!target.endsWith(`/${label}`)) {
        return {
          code: 113,
          termination: "exit",
          stdout: "",
          stderr: defaultState === "absent" ? "Could not find service" : "Operation not permitted",
        };
      }
      return {
        code: 0,
        termination: "exit",
        stderr: "",
        stdout: [
          `${target} = {`,
          `\tpath = ${plist}`,
          `\tprogram = ${process.execPath}`,
          "\targuments = {",
          `\t\t${process.execPath}`,
          `\t\t${path.join(overlap ? checkout : other, "dist", "index.js")}`,
          "\t\tgateway",
          "\t}",
          "\tstate = running",
          `\tpid = ${process.pid}`,
          "}",
        ].join("\n"),
      };
    });
    const result = await withMockedPlatform("darwin", () =>
      resolveLiveManagedGatewayDistFence(checkout, { env: { HOME: home }, requireVerified: true }),
    );
    expect(result.refuse).toBe(refuse);
    if (result.refuse) {
      expect(result.message).toContain(overlap ? label : "Cannot verify");
    }
    expect(native.mock.calls.every(([args]) => args[0] === "print")).toBe(true);
  },
);
