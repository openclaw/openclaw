import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { SpawnResult } from "../process/exec.js";
import { inspectGog, inspectGogUpgrade, upgradeGog } from "./gmail-gog.js";
import { gogServeSchema } from "./gmail.test-support.js";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
// mock-isolation: supply external command responses without executing host tools.
vi.mock("../process/exec.js", () => ({ runUtf8CommandWithTimeout: mocks.run }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const success = (stdout = ""): SpawnResult => ({
  code: 0,
  stdout,
  stderr: "",
  signal: null,
  killed: false,
  termination: "exit",
});
const schemaResult = (flags = ["token-env", "hook-token-env"]) =>
  success(JSON.stringify(gogServeSchema(flags)));

beforeEach(async () => {
  mocks.run.mockReset().mockResolvedValue(schemaResult());
  const bin = tempDirs.make("openclaw-gmail-gog-bin-");
  await writeExecutable(path.join(bin, "gog"));
  vi.stubEnv("PATH", bin);
});
afterEach(() => vi.unstubAllEnvs());

it.each([
  { flags: ["token-env", "hook-token-env"], support: "supported" },
  { flags: [], support: "unsupported" },
  { flags: ["token-env"], support: "unsupported" },
  { flags: ["hook-token-env"], support: "unsupported" },
])("recognizes both secure token sources: $flags", async ({ flags, support }) => {
  mocks.run.mockResolvedValue(schemaResult(flags));
  await expect(inspectGog()).resolves.toMatchObject({ support });
});

it.each([
  "bad-json",
  "version",
  "command",
  "name",
  "flags",
  "duplicate",
  "literal",
  "env-type",
  "exit",
  "signal",
  "timeout",
  "limit",
  "truncated",
  "spawn",
])("reports an inconclusive capability check: %s", async (failure) => {
  const schema = gogServeSchema();
  const result = schemaResult();
  if (failure === "version") {
    schema.schema_version = 2;
  }
  if (failure === "command") {
    schema.command.type = "argument";
  }
  if (failure === "name") {
    schema.command.name = "start";
  }
  if (failure === "duplicate") {
    schema.command.flags.push({ name: "token", type: "string" });
  }
  if (failure === "literal") {
    schema.command.flags = schema.command.flags.filter((flag) => flag.name !== "token");
  }
  if (failure === "env-type") {
    const flag = schema.command.flags.find((entry) => entry.name === "token-env");
    if (flag) {
      flag.type = "bool";
    }
  }
  result.stdout =
    failure === "bad-json"
      ? "not json"
      : failure === "flags"
        ? JSON.stringify({ ...schema, command: { ...schema.command, flags: [null] } })
        : JSON.stringify(schema);
  if (failure === "exit") {
    result.code = 1;
  }
  if (failure === "signal") {
    result.signal = "SIGTERM";
  }
  if (failure === "timeout") {
    result.termination = "timeout";
  }
  if (failure === "limit") {
    result.outputLimitExceeded = true;
  }
  if (failure === "truncated") {
    result.stdoutTruncatedBytes = 1;
  }
  mocks.run.mockResolvedValue(result);
  if (failure === "spawn") {
    mocks.run.mockRejectedValue(new Error("private diagnostic"));
  }
  await expect(inspectGog()).resolves.toMatchObject({ support: "indeterminate" });
});

it("propagates cancellation instead of treating it as an inconclusive check", async () => {
  const controller = new AbortController();
  mocks.run.mockImplementation(async () => {
    controller.abort(new Error("cancelled probe"));
    return schemaResult();
  });
  await expect(inspectGog({ signal: controller.signal })).rejects.toThrow("cancelled probe");
});

async function writeExecutable(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

async function createBrewFixture() {
  const root = tempDirs.make("openclaw-gmail-gog-");
  const rack = path.join(root, "Cellar", "gogcli");
  const binary = path.join(rack, "0.47.1", "bin", "gog");
  const bin = path.join(root, "bin");
  const selected = path.join(bin, "gog");
  const brew = path.join(bin, "brew");
  await writeExecutable(binary);
  await writeExecutable(brew);
  await fs.symlink(binary, selected);
  const state = {
    pinned: false,
    secure: false,
    formula: "openclaw/tap/gogcli",
    gogPaths: new Set([selected]),
    mutations: [] as string[],
    mutate: async (_command: string): Promise<SpawnResult> => success(),
  };
  vi.stubEnv("PATH", bin);
  mocks.run.mockImplementation(
    async ([command, ...args]: string[], options: { env?: NodeJS.ProcessEnv }) => {
      if (command !== undefined && state.gogPaths.has(command)) {
        return schemaResult(state.secure ? undefined : []);
      }
      expect(command).toBe(brew);
      expect(options.env?.HOMEBREW_NO_AUTO_UPDATE).toBe("1");
      switch (args.join(" ")) {
        case "list --formula --full-name":
          return success(state.formula);
        case "list --formula --pinned":
          return success(state.pinned ? "gogcli" : "");
        case `--cellar ${state.formula}`:
          return success(rack);
        case "update":
          state.mutations.push("update");
          return state.mutate("update");
        case `upgrade ${state.formula}`:
          state.mutations.push("upgrade");
          return state.mutate("upgrade");
        default:
          throw new Error(`Unexpected fixture command: ${args.join(" ")}`);
      }
    },
  );
  return { root, rack, binary, selected, brew, state, options: { env: { PATH: bin } } };
}

it
  .skipIf(process.platform === "win32")
  .each(["owned", "wrapper", "unowned-rack-file", "pinned", "custom-tap"])(
  "offers Homebrew upgrade only for its unpinned binary: %s",
  async (kind) => {
    const fixture = await createBrewFixture();
    if (kind === "pinned") {
      fixture.state.pinned = true;
    }
    if (kind === "custom-tap") {
      fixture.state.formula = "custom/tap/gogcli";
    }
    if (kind === "wrapper" || kind === "unowned-rack-file") {
      await fs.unlink(fixture.selected);
      if (kind === "wrapper") {
        await writeExecutable(fixture.selected);
      } else {
        const unowned = path.join(fixture.rack, "scripts", "gog");
        await writeExecutable(unowned);
        await fs.symlink(unowned, fixture.selected);
      }
    }
    const inspection = await inspectGog(fixture.options);
    const upgrade = await inspectGogUpgrade(inspection, fixture.options);
    expect(upgrade.eligible).toBe(kind === "owned");
    expect(fixture.state.mutations).toEqual([]);
  },
);

it.skipIf(process.platform === "win32").each(["pin", "wrapper", "cancel", "cancel-during-update"])(
  "revalidates upgrade authority after consent: %s",
  async (change) => {
    const fixture = await createBrewFixture();
    const approved = await inspectGogUpgrade(await inspectGog(fixture.options), fixture.options);
    expect(approved.eligible).toBe(true);
    if (!approved.eligible) {
      return;
    }
    const controller = new AbortController();
    if (change === "pin") {
      fixture.state.pinned = true;
    }
    if (change === "wrapper") {
      await fs.unlink(fixture.selected);
      await writeExecutable(fixture.selected);
    }
    if (change === "cancel") {
      controller.abort(new Error("cancelled upgrade"));
    }
    if (change === "cancel-during-update") {
      fixture.state.mutate = async () => {
        controller.abort(new Error("cancelled upgrade"));
        return success();
      };
    }
    const upgrading = upgradeGog(approved, { ...fixture.options, signal: controller.signal });
    if (change.startsWith("cancel")) {
      await expect(upgrading).rejects.toThrow("cancelled upgrade");
    } else {
      await expect(upgrading).resolves.toMatchObject({ inspection: { support: "unsupported" } });
    }
    expect(fixture.state.mutations).toEqual(change === "cancel-during-update" ? ["update"] : []);
  },
);

it
  .skipIf(process.platform === "win32")
  .each([
    "secure",
    "unchanged",
    "failed-replaced",
    "failed-removed",
    "timeout",
    "pin-during-update",
    "fallback-selected",
  ])("reconciles the actual installation after Homebrew: %s", async (outcome) => {
  const fixture = await createBrewFixture();
  const fallback = path.join(fixture.root, "other", "gog");
  if (outcome === "fallback-selected") {
    await writeExecutable(fallback);
    fixture.state.gogPaths.add(fallback);
    fixture.options.env.PATH += `${path.delimiter}${path.dirname(fallback)}`;
  }
  const approved = await inspectGogUpgrade(await inspectGog(fixture.options), fixture.options);
  expect(approved.eligible).toBe(true);
  if (!approved.eligible) {
    return;
  }
  fixture.state.mutate = async (command) => {
    if (command === "update" && outcome === "pin-during-update") {
      fixture.state.pinned = true;
    }
    if (command !== "upgrade") {
      return success();
    }
    if (outcome === "secure" || outcome === "failed-replaced") {
      const replacement = path.join(fixture.rack, "0.48.0", "bin", "gog");
      await writeExecutable(replacement);
      await fs.unlink(fixture.selected);
      await fs.symlink(replacement, fixture.selected);
      fixture.state.secure = true;
    }
    if (outcome === "fallback-selected") {
      await fs.unlink(fixture.selected);
      fixture.state.secure = true;
    }
    if (outcome === "failed-removed") {
      await fs.unlink(fixture.selected);
    }
    return {
      ...success(),
      ...(outcome.startsWith("failed") ? { code: 1 } : {}),
      ...(outcome === "timeout" ? { code: null, termination: "timeout" as const } : {}),
    };
  };
  const result = await upgradeGog(approved, fixture.options);
  expect(fixture.state.mutations).toEqual(
    outcome === "pin-during-update" ? ["update"] : ["update", "upgrade"],
  );
  expect(result.inspection).toEqual({
    executable:
      outcome === "failed-removed"
        ? undefined
        : outcome === "fallback-selected"
          ? fallback
          : fixture.selected,
    support: ["secure", "failed-replaced", "fallback-selected"].includes(outcome)
      ? "supported"
      : outcome === "failed-removed"
        ? "indeterminate"
        : "unsupported",
  });
  expect(result.message.includes("supports secure")).toBe(
    ["secure", "failed-replaced", "fallback-selected"].includes(outcome),
  );
});
