import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as packageMetadata from "../../infra/update-check-package-target.js";
import * as updateCheck from "../../infra/update-check.js";
import * as updateGlobal from "../../infra/update-global.js";
import type { ResolvedGlobalInstallTarget } from "../../infra/update-global.js";
import * as processRunner from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../../state/openclaw-schema-versions.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import * as shared from "./shared.js";
import * as servicePlan from "./update-command-service-plan.js";
import { updateCommand } from "./update-command.js";

const triage = vi.hoisted(() => vi.fn());
vi.mock("../../infra/update-triage.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-triage.js")>()),
  prepareUpdateFailureTriage: async () => triage,
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
const TARGET = "2026.11.19";
// A schema-compatible target, so only the install layout can stop the switch.
const CURRENT_SCHEMA_VERSIONS = {
  state: OPENCLAW_STATE_SCHEMA_VERSION,
  agent: OPENCLAW_AGENT_SCHEMA_VERSION,
};
let base: string;
let checkout: string;
let globalRoot: string;
let link: string;
let commands: string[];
let output: unknown[];
let lines: string[];

async function writeManifest(root: string) {
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw","version":"2026.11.5"}');
}

function pnpmTarget(packageRoot = link): ResolvedGlobalInstallTarget {
  return {
    manager: "pnpm",
    command: "pnpm",
    globalRoot,
    packageRoot,
  };
}

beforeEach(async () => {
  base = dirs.make("update-checkout-link-switch-");
  checkout = path.join(base, "checkout");
  await writeManifest(checkout);
  await fs.mkdir(path.join(checkout, ".git"));
  globalRoot = path.join(base, "pnpm-home", "global", "5", "node_modules");
  link = path.join(globalRoot, "openclaw");
  await fs.mkdir(globalRoot, { recursive: true });
  await fs.symlink(checkout, link);
  vi.stubEnv("HOME", base);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(base, "state"));
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(base, "state", "openclaw.json"));
  await fs.mkdir(path.join(base, "state"), { recursive: true });
  await fs.writeFile(
    path.join(base, "state", "openclaw.json"),
    `${JSON.stringify({ update: { channel: "dev" } })}\n`,
  );
  commands = [];
  vi.spyOn(processRunner, "runCommandWithTimeout").mockImplementation(async (argv) => {
    commands.push(argv.join(" "));
    return createCommandResult({ stderr: "not available in this fixture", code: 1 });
  });
  output = [];
  lines = [];
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
    output.push(value);
  });
  vi.spyOn(defaultRuntime, "log").mockImplementation((value) => {
    lines.push(String(value));
  });
  vi.spyOn(defaultRuntime, "error").mockImplementation((value) => {
    lines.push(String(value));
  });
  triage.mockClear();
});

afterEach(async () => {
  await closeStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([true, false])(
  "refuses `openclaw update --channel beta` before any change (json: %s)",
  async (json) => {
    vi.spyOn(shared, "resolveUpdateRoot").mockResolvedValue(link);
    vi.spyOn(process, "cwd").mockReturnValue(checkout);
    vi.spyOn(updateCheck, "resolveUpdateInstallKind").mockResolvedValue("git");
    vi.spyOn(updateCheck, "resolveNpmChannelTag").mockResolvedValue({
      tag: "beta",
      version: TARGET,
    });
    vi.spyOn(packageMetadata, "fetchNpmPackageTargetStatus").mockResolvedValue({
      version: TARGET,
      nodeEngine: null,
      schemaVersions: CURRENT_SCHEMA_VERSIONS,
    });
    // Global-root discovery runs `pnpm root -g`; the fixture supplies its answer directly.
    vi.spyOn(updateGlobal, "resolveGlobalInstallTarget").mockResolvedValue(pnpmTarget());
    vi.spyOn(servicePlan, "resolveManagedServicePackageUpdatePlan").mockResolvedValue({
      rootRedirect: null,
      serviceUnitTarget: path.join(checkout, "dist", "index.js"),
    });

    await expect(updateCommand({ json, yes: true, channel: "beta" })).rejects.toMatchObject({
      code: 1,
    });

    const text = lines.join("\n");
    if (json) {
      expect(output.at(-1)).toMatchObject({
        status: "error",
        reason: "unsupported-package-target",
        failedStep: {
          failureFacts: [expect.objectContaining({ code: "unsupported-package-target" })],
          // Agents read the command that keeps following the channel from the failed step.
          recoverySteps: [
            { kind: "continue-update", command: "openclaw config set update.channel beta" },
            { kind: "continue-update", command: "openclaw update" },
          ],
        },
      });
    } else {
      expect(text).toContain(`Switch to openclaw@${TARGET} not started`);
      expect(text).toContain("run `openclaw triage` or ask this instance's agent");
      expect(text).toContain(
        "run `openclaw config set update.channel beta`, then `openclaw update`",
      );
      // The run is refused at target admission, before staging begins.
      expect(text).not.toContain("Phase: staging");
    }
    expect(text).toContain("nothing was stopped or changed");
    // A refusal before admission is not a failed update to triage.
    expect(triage).not.toHaveBeenCalled();
    // Nothing was installed or rewritten: the link, the checkout and the config stand.
    expect(commands.filter((command) => /\b(add|install|i)\b/u.test(command))).toEqual([]);
    expect(await fs.realpath(link)).toBe(await fs.realpath(checkout));
    await expect(fs.readFile(path.join(base, "state", "openclaw.json"), "utf8")).resolves.toContain(
      '"channel":"dev"',
    );
    expect(
      (await fs.readdir(path.dirname(globalRoot))).filter((name) => name !== "node_modules"),
    ).toEqual([]);
  },
);
